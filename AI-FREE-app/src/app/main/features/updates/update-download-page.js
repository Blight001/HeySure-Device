const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');
const { getSuggestedFileNameFromUrl, toDebugString } = require('./update-notice');
const { safeMkdir } = require('./update-package');

const DOWNLOAD_BUTTON_SCRIPT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalizedText = (value) => String(value || '').replace(/\\s+/g, '');
  const containsDownload = (value) => {
    const text = normalizedText(value);
    return text.includes('下载') || text.toLowerCase().includes('download');
  };
  const isInteractive = (el) => !!el && (
    el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'INPUT' || el.getAttribute?.('role') === 'button'
  );
  const getText = (el) => String(el?.innerText || el?.textContent || el?.value || '').replace(/\\s+/g, ' ').trim();
  const scoreTarget = (el) => {
    const text = getText(el);
    if (!text || !containsDownload(text)) return -Infinity;
    const normalized = normalizedText(text);
    const exact = normalized === '下载' || normalized.toLowerCase() === 'download';
    let score = exact ? 1000 : 0;
    if (isInteractive(el)) score += 200;
    if (String(el.tagName || '').toUpperCase() === 'BUTTON') score += 120;
    if (String(el.className || '').includes('btn-box')) score += 100;
    if (String(el.className || '').includes('el-button')) score += 60;
    return score - Math.min(text.length, 300);
  };
  const findInRoot = (root) => {
    const selectors = ['button', 'a', '[role="button"]', 'input[type="button"]', 'input[type="submit"]', 'span', 'div'];
    const candidates = Array.from(root.querySelectorAll(selectors.join(','))).map((node) => ({
      candidate: isInteractive(node)
        ? node
        : node.closest?.('button,a,[role="button"],input[type="button"],input[type="submit"],label') || node,
      score: scoreTarget(node),
    })).filter((item) => item.score !== -Infinity).sort((left, right) => right.score - left.score);
    if (candidates.length) return candidates[0].candidate;
    for (const node of Array.from(root.querySelectorAll('*'))) {
      if (!node.shadowRoot) continue;
      const found = findInRoot(node.shadowRoot);
      if (found) return found;
    }
    return null;
  };
  const pickTarget = () => {
    const roots = [document];
    for (const frame of Array.from(document.querySelectorAll('iframe'))) {
      try { if (frame.contentDocument) roots.push(frame.contentDocument); } catch (_) {}
    }
    for (const root of roots) {
      const target = findInRoot(root);
      if (target) return target;
    }
    return null;
  };
  const getClickable = () => {
    const target = pickTarget();
    if (!target) return null;
    const clickable = target.closest?.('button,a,[role="button"],input[type="button"],input[type="submit"]') || target;
    try { clickable.scrollIntoView?.({ block: 'center', inline: 'center' }); } catch (_) {}
    const rect = clickable.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return {
      tagName: String(clickable.tagName || '').toLowerCase(),
      text: getText(clickable),
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      html: clickable.outerHTML || '',
      className: String(clickable.className || ''),
    };
  };
  for (let index = 0; index < 60; index += 1) {
    const target = getClickable();
    if (target) return target;
    await wait(250);
  }
  return false;
})()`;

function resolveUpdatePageIcon() {
  const candidate = process.resourcesPath ? path.join(process.resourcesPath, 'resource', 'logo.ico') : '';
  return candidate && fs.existsSync(candidate) ? candidate : undefined;
}

function createUpdatePageWindow(showWindow) {
  return new BrowserWindow({
    show: Boolean(showWindow),
    autoHideMenuBar: true,
    width: 1280,
    height: 900,
    icon: resolveUpdatePageIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: false,
    },
  });
}

function updateDownloadErrorMessage(error) {
  return error?.message || String(error);
}

class DownloadPageSession {
  /** @param {Record<string, any>} options */
  constructor(options) {
    this.window = options.window;
    this.downloadUrl = options.downloadUrl;
    this.targetDir = options.targetDir;
    this.logger = options.logger;
    this.onProgress = options.onProgress;
    this.showWindow = options.showWindow;
    this.allowAutoClickOnAnyPage = options.allowAutoClickOnAnyPage;
    this.complete = (_value) => {};
    this.fail = (_error) => {};
    this.settled = false;
    this.clickTimer = null;
    this.timeoutTimer = null;
    this.clickSent = false;
    this.downloadStarted = false;
    this.postClickTimeoutExtended = false;
  }

  setProgress(percent, statusText = '') {
    try {
      if (this.window.isDestroyed()) return;
      const active = typeof percent === 'number' && Number.isFinite(percent) && percent >= 0;
      this.window.setProgressBar(active ? Math.min(Math.max(percent / 100, 0), 1) : -1);
      const suffix = statusText ? ` · ${statusText}` : '';
      const title = active ? `AI-FREE - 更新页 ${Math.max(0, Math.min(100, Math.round(percent)))}%${suffix}` : 'AI-FREE - 更新页';
      this.window.setTitle(title);
    } catch (_) {}
  }

  cleanup() {
    if (this.clickTimer) clearTimeout(this.clickTimer);
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.clickTimer = null;
    this.timeoutTimer = null;
    try { if (!this.window.isDestroyed()) this.window.close(); } catch (_) {}
  }

  settle(callback, value) {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    callback(value);
  }

  armTimeout(delayMs = 45000) {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = setTimeout(() => {
      if (this.settled || this.window.isDestroyed() || this.downloadStarted) return;
      if (this.clickSent && !this.postClickTimeoutExtended) {
        this.postClickTimeoutExtended = true;
        this.logger.warn?.('[更新] 已点击但未接收到下载事件，延长等待', {
          delayMs,
          url: this.window.webContents.getURL(),
        });
        this.armTimeout(180000);
        return;
      }
      this.fail(new Error('自动点击下载按钮超时'));
    }, delayMs);
  }

  sendClick(target) {
    try {
      this.window.webContents.focus();
      this.clickSent = true;
      const base = { x: target.x, y: target.y, button: 'left' };
      this.window.webContents.sendInputEvent({ ...base, type: 'mouseMove' });
      this.window.webContents.sendInputEvent({ ...base, type: 'mouseDown', clickCount: 1 });
      this.window.webContents.sendInputEvent({ ...base, type: 'mouseUp', clickCount: 1 });
      return true;
    } catch (error) {
      this.clickSent = false;
      this.logger.warn?.('[更新] 真实鼠标点击发送失败:', updateDownloadErrorMessage(error));
      return false;
    }
  }

  async clickDownloadButton() {
    if (this.window.isDestroyed()) return false;
    if (this.clickSent) return true;
    try {
      this.logger.warn?.('[更新] 开始尝试自动点击下载按钮');
      const target = await this.window.webContents.executeJavaScript(DOWNLOAD_BUTTON_SCRIPT, true);
      if (!target) return false;
      if (typeof target.x !== 'number' || typeof target.y !== 'number') {
        this.logger.warn?.('[更新] 自动点击目标缺少坐标', toDebugString(target));
        return false;
      }
      this.logger.warn?.('[更新] 自动点击目标命中', toDebugString({
        tagName: target.tagName, text: target.text, x: target.x, y: target.y,
        width: target.width, height: target.height,
      }));
      return this.sendClick(target);
    } catch (error) {
      this.logger.warn?.('[更新] 页面点击脚本执行失败:', updateDownloadErrorMessage(error));
      return false;
    }
  }

  trackDownload(item, savePath, suggestedName) {
    item.on('updated', () => {
      try {
        const receivedBytes = item.getReceivedBytes();
        const total = item.getTotalBytes();
        const percent = total > 0 ? Math.min(99.5, (receivedBytes / total) * 100) : null;
        this.onProgress({ phase: 'downloading', receivedBytes, totalBytes: total > 0 ? total : null, percent });
        this.setProgress(percent, '正在下载');
      } catch (_) {}
    });
    item.once('done', (_event, state) => {
      if (state === 'completed') this.complete({ savePath, suggestedName });
      else this.fail(new Error(`页面下载失败: ${state}`));
    });
  }

  handleDownload(_event, item) {
    try {
      this.downloadStarted = true;
      if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
      const fallback = `update-${Date.now()}.zip`;
      const suggestedName = String(
        (typeof item.getFilename === 'function' && item.getFilename())
        || item.suggestedFilename
        || getSuggestedFileNameFromUrl(this.downloadUrl, fallback)
        || fallback,
      ).trim();
      const savePath = path.join(this.targetDir, suggestedName);
      this.logger.warn?.('[更新] 接收到下载任务', toDebugString({ suggestedName, savePath }));
      item.setSavePath(savePath);
      this.trackDownload(item, savePath, suggestedName);
    } catch (error) {
      this.fail(error);
    }
  }

  scheduleClick() {
    if (this.clickSent || this.clickTimer) return;
    if (this.showWindow) this.window.showInactive?.();
    this.clickTimer = setTimeout(async () => {
      try {
        const clicked = await this.clickDownloadButton();
        if (!clicked) this.logger.warn?.('[更新] 未找到中文“下载”按钮，等待页面继续渲染');
      } catch (error) {
        this.logger.warn?.('[更新] 自动点击下载按钮失败:', updateDownloadErrorMessage(error));
      }
    }, this.showWindow ? 1500 : 0);
  }

  handleFinishedLoad() {
    try {
      const currentUrl = String(this.window.webContents.getURL() || '');
      this.logger.warn?.('[更新] 下载页已加载', { url: currentUrl, showWindow: this.showWindow });
      if (!this.allowAutoClickOnAnyPage && !/\/view\//i.test(currentUrl)) {
        this.logger.warn?.('[更新] 当前不是最终下载页，跳过自动点击', { url: currentUrl });
        return;
      }
      this.scheduleClick();
    } catch (error) {
      this.logger.warn?.('[更新] 自动点击下载按钮失败:', updateDownloadErrorMessage(error));
    }
  }

  handleFailedLoad(_event, errorCode, errorDescription, validatedURL, isMainFrame) {
    if (!isMainFrame) return;
    if (errorCode === -3 || String(errorDescription || '').includes('ERR_ABORTED')) {
      this.logger.warn?.('[更新] 下载页发生重定向中断，继续等待最终页面', { errorCode, errorDescription, validatedURL });
      return;
    }
    this.fail(new Error(`打开下载页失败: ${errorDescription || errorCode || validatedURL || 'unknown'}`));
  }

  openRedirect(nextUrl) {
    const targetUrl = String(nextUrl || '').trim();
    this.logger.warn?.('[更新] 下载页尝试打开新窗口', { targetUrl });
    if (targetUrl) this.window.loadURL(targetUrl).catch(() => {});
    return { action: 'deny' };
  }

  load() {
    this.window.loadURL(this.downloadUrl).catch((error) => {
      const message = updateDownloadErrorMessage(error);
      if (message.includes('ERR_ABORTED') || String(error?.code || '').includes('ERR_ABORTED')) {
        this.logger.warn?.('[更新] 下载页 loadURL 发生重定向中断，继续等待最终页面', { downloadUrl: this.downloadUrl, error: message });
        return;
      }
      this.logger.warn?.('[更新] 下载页 loadURL 失败', { downloadUrl: this.downloadUrl, error: message });
      this.fail(error);
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.complete = (value) => this.settle(resolve, value);
      this.fail = (error) => this.settle(reject, error);
      this.window.webContents.session.once('will-download', (event, item) => this.handleDownload(event, item));
      this.window.webContents.setWindowOpenHandler(({ url }) => this.openRedirect(url));
      this.window.webContents.on('did-finish-load', () => this.handleFinishedLoad());
      this.window.webContents.on('did-fail-load', (...args) => this.handleFailedLoad(...args));
      this.window.webContents.on('render-process-gone', (_event, details) => {
        this.fail(new Error(`下载页进程异常退出: ${details?.reason || 'unknown'}`));
      });
      this.load();
      this.armTimeout();
    });
  }
}

async function openDownloadPageAndAutoClick({
  url,
  saveDir,
  logger = console,
  onProgress = (_progress) => {},
  showWindow = false,
  allowAutoClickOnAnyPage = false,
}) {
  const downloadUrl = String(url || '').trim();
  if (!downloadUrl) throw new Error('下载页地址为空');
  const targetDir = String(saveDir || '').trim();
  if (!targetDir) throw new Error('未指定下载目录');
  safeMkdir(targetDir);
  logger.warn?.('[更新] 准备打开下载页', { downloadUrl, saveDir: targetDir, showWindow });
  const window = createUpdatePageWindow(showWindow);
  if (showWindow) {
    try { window.show(); } catch (_) {}
    try { window.focus(); } catch (_) {}
    try { window.moveTop(); } catch (_) {}
  }
  return new DownloadPageSession({
    window, downloadUrl, targetDir, logger, onProgress, showWindow, allowAutoClickOnAnyPage,
  }).start();
}

module.exports = { openDownloadPageAndAutoClick };
