const fs = require('fs');
const path = require('path');
const { appContext } = require('../runtime/app-context');
const { compareVersions } = require('../../shared/version-utils');
const { summarizeUpdatePayload } = require('../utils/update-payload');
const {
  createUpdateUiPayload,
  shouldIgnoreUpdateReceipt,
  getSuggestedFileNameFromUrl,
  looksLikeWebPageUrl,
  toDebugString,
  extractUpdatePayload,
} = require('../features/updates/update-notice');
const { openDownloadPageAndAutoClick } = require('../features/updates/update-download-page');
const {
  safeMkdir,
  clearDirectory,
  cleanupUpdateStorageRoot,
  isArchiveFile,
  findLaunchTarget,
  downloadFile,
  extractDownloadedPackage,
  cleanupDownloadedArchive,
  getUpdateStorageRoot,
} = require('../features/updates/update-package');

function updaterErrorMessage(error) {
  return error?.message || String(error);
}

function createUpdaterContext(input) {
  return {
    app: input.app,
    fs: input.fs || fs,
    path: input.path || path,
    logger: input.logger || console,
    getMainWindow: input.getMainWindow || (() => null),
    sendToSide: input.sendToSide || (() => {}),
    appName: input.appName || 'AI-FREE',
    isDevMode: input.isDevMode === true,
    updateInProgress: false,
  };
}

function setWindowProgress(context, percent, statusText = '') {
  try {
    const mainWindow = context.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const active = typeof percent === 'number' && Number.isFinite(percent) && percent >= 0;
    mainWindow.setProgressBar(active ? Math.min(Math.max(percent / 100, 0), 1) : -1);
    const suffix = statusText ? ` · ${statusText}` : '';
    const title = active
      ? `${context.appName} - 更新中 ${Math.max(0, Math.min(100, Math.round(percent)))}%${suffix}`
      : context.appName;
    mainWindow.setTitle(title);
  } catch (error) {
    context.logger.warn?.('[更新] 更新窗口进度失败:', updaterErrorMessage(error));
  }
}

function emitUpdateEvent(context, channel, payload) {
  try {
    context.sendToSide(channel, payload);
  } catch (error) {
    context.logger.warn?.('[更新] 通知侧边栏失败:', updaterErrorMessage(error));
  }
}

function logNormalizedUpdate(context, payload, normalized) {
  context.logger.warn?.('[更新] startAppUpdate 收到原始载荷', toDebugString({
    ...summarizeUpdatePayload(payload),
    keys: Object.keys(payload || {}),
  }));
  context.logger.warn?.('[更新] startAppUpdate 归一化结果', toDebugString({
    type: normalized.type,
    messageType: normalized.messageType,
    version: normalized.version,
    downloadUrl: normalized.downloadUrl,
    openUrl: normalized.openUrl,
    launchMode: normalized.launchMode,
    openInBrowser: normalized.openInBrowser,
    entryFile: normalized.entryFile,
    fileName: normalized.fileName,
  }));
}

function shouldUseDownloadPage(normalized, browserUrl) {
  if (!browserUrl || !looksLikeWebPageUrl(browserUrl)) return false;
  const launchMode = String(normalized.launchMode || '').toLowerCase();
  return Boolean(
    normalized.openInBrowser
    || ['browser', 'open', 'open_link', 'open-url', 'external'].includes(launchMode)
    || (!normalized.entryFile && !normalized.fileName),
  );
}

function emitDownloadProgress(context, version, progress, pageMode = false) {
  emitUpdateEvent(context, 'app-update-progress', {
    ...progress,
    version,
    message: pageMode
      ? progress.phase === 'downloading' ? '正在从网页下载更新包...' : '正在打开下载页并点击下载...'
      : '正在下载更新...',
  });
  if (typeof progress.percent === 'number') {
    setWindowProgress(context, progress.percent, progress.phase === 'downloading' ? '正在下载' : '正在打开下载页');
  }
}

async function extractUpdateDownload(context, downloadPath, extractDir, entryFile, label) {
  clearDirectory(extractDir);
  safeMkdir(extractDir);
  context.logger.warn?.(`[更新] ${label}准备进入解压阶段`, toDebugString({
    downloadPath, extractDir, isArchiveFile: isArchiveFile(downloadPath),
  }));
  if (isArchiveFile(downloadPath)) {
    await extractDownloadedPackage(downloadPath, extractDir, context.logger);
  } else {
    context.fs.copyFileSync(downloadPath, context.path.join(extractDir, context.path.basename(downloadPath)));
  }
  const launchTarget = await findLaunchTarget(extractDir, entryFile);
  context.logger.warn?.(`[更新] ${label}查找启动文件完成`, toDebugString({ extractDir, launchTarget }));
  if (!launchTarget || !context.fs.existsSync(launchTarget)) throw new Error('更新包中未找到可执行文件');
  return launchTarget;
}

function completeUpdate(context, version, downloadPath, launchTarget, mode = '') {
  cleanupDownloadedArchive(downloadPath, context.logger);
  appContext.setPendingUpdateInstall({ version, target: launchTarget });
  emitUpdateEvent(context, 'app-update-complete', {
    ok: true,
    version,
    launchTarget,
    message: '更新包已下载完成，请关闭当前软件后继续安装',
    installOnExit: true,
  });
  setWindowProgress(context, -1, '');
  return { ok: true, version, downloadPath, launchTarget, ...(mode ? { mode } : {}) };
}

function emitExtracting(context, version, message) {
  emitUpdateEvent(context, 'app-update-progress', { phase: 'extracting', version, message, percent: 99 });
  setWindowProgress(context, 99, '正在解压');
}

async function runPageUpdate(context, normalized, version, browserUrl) {
  const workDir = getUpdateStorageRoot(context.path);
  const result = await openDownloadPageAndAutoClick({
    url: browserUrl,
    saveDir: workDir,
    logger: context.logger,
    showWindow: context.isDevMode,
    onProgress: (progress) => emitDownloadProgress(context, version, progress, true),
  });
  const downloadPath = String(result?.savePath || '').trim();
  if (!downloadPath || !context.fs.existsSync(downloadPath)) throw new Error('网页下载未生成文件');
  context.logger.warn?.('[更新] 网页下载文件就绪', toDebugString({
    downloadPath,
    size: context.fs.statSync(downloadPath)?.size ?? null,
    ext: context.path.extname(downloadPath),
  }));
  emitExtracting(context, version, '网页下载完成，正在解压...');
  const extractDir = context.path.join(workDir, 'extracted');
  const launchTarget = await extractUpdateDownload(context, downloadPath, extractDir, normalized.entryFile, '网页');
  return completeUpdate(context, version, downloadPath, launchTarget, 'auto-click-page');
}

function resolveDirectUpdatePaths(context, normalized, version) {
  const archiveName = normalized.fileName || getSuggestedFileNameFromUrl(normalized.downloadUrl, `update-${version}.zip`);
  const workDir = getUpdateStorageRoot(context.path);
  return {
    workDir,
    downloadPath: context.path.join(workDir, archiveName || `update-${version}.zip`),
    extractDir: context.path.join(workDir, 'extracted'),
  };
}

async function runDirectUpdate(context, normalized, version) {
  const paths = resolveDirectUpdatePaths(context, normalized, version);
  safeMkdir(paths.workDir);
  clearDirectory(paths.extractDir);
  emitUpdateEvent(context, 'app-update-progress', {
    phase: 'preparing', version, message: '准备下载更新...', percent: 0,
  });
  setWindowProgress(context, 0, '准备下载');
  await downloadFile(normalized.downloadUrl, paths.downloadPath, (progress) => {
    emitDownloadProgress(context, version, progress, false);
  });
  context.logger.warn?.('[更新] 直链下载文件就绪', toDebugString({
    downloadPath: paths.downloadPath,
    size: context.fs.statSync(paths.downloadPath)?.size ?? null,
    ext: context.path.extname(paths.downloadPath),
  }));
  emitExtracting(context, version, '下载完成，正在解压...');
  const launchTarget = await extractUpdateDownload(
    context,
    paths.downloadPath,
    paths.extractDir,
    normalized.entryFile,
    '直链',
  );
  return completeUpdate(context, version, paths.downloadPath, launchTarget);
}

function failUpdate(context, version, error, logPrefix) {
  const message = updaterErrorMessage(error);
  setWindowProgress(context, -1, '');
  emitUpdateEvent(context, 'app-update-error', { ok: false, version, message });
  context.logger.error?.(`[更新] ${logPrefix}:`, message);
  return { ok: false, message };
}

async function startAppUpdate(context, payload = {}) {
  if (context.updateInProgress) return { ok: false, message: '更新正在进行中' };
  context.logger.warn?.('[更新] startAppUpdate 被调用');
  const normalized = extractUpdatePayload(payload);
  logNormalizedUpdate(context, payload, normalized);
  if (!normalized.version || (!normalized.downloadUrl && !normalized.openUrl)) {
    return { ok: false, message: '更新信息不完整，缺少版本号或下载地址' };
  }
  const version = String(normalized.version).trim();
  const browserUrl = String(normalized.openUrl || normalized.downloadUrl).trim();
  const pageMode = shouldUseDownloadPage(normalized, browserUrl);
  context.logger.warn?.('[更新] 模式判断', toDebugString({
    version,
    downloadUrl: normalized.downloadUrl,
    browserUrl,
    shouldAutoClickDownloadPage: pageMode,
    launchMode: normalized.launchMode,
    isDevMode: context.isDevMode,
  }));
  context.updateInProgress = true;
  emitUpdateEvent(context, 'app-update-activated', createUpdateUiPayload(normalized, {
    currentVersion: String(context.app.getVersion() || '').trim(), phase: 'activated',
  }));
  try {
    return pageMode
      ? await runPageUpdate(context, normalized, version, browserUrl)
      : await runDirectUpdate(context, normalized, version);
  } catch (error) {
    return failUpdate(context, version, error, pageMode ? '页面自动下载失败' : '更新失败');
  } finally {
    context.updateInProgress = false;
  }
}

function isServerUpdateCommand(normalized, type, messageType) {
  const knownTypes = new Set(['app_update', 'update', 'software_update', 'upgrade']);
  if (knownTypes.has(type) || knownTypes.has(messageType)) return true;
  if (normalized.version && normalized.downloadUrl) return true;
  return Boolean(normalized.version && (normalized.raw?.update_link || normalized.raw?.updateLink));
}

function logServerUpdateCommand(context, messageData, normalized, type, messageType) {
  context.logger.warn?.('[更新] handleServerUpdateCommand 收到消息', toDebugString({
    rawType: messageData?.type,
    rawMessageType: messageData?.message_type || messageData?.messageType,
    normalizedType: type,
    normalizedMessageType: messageType,
    normalizedVersion: normalized.version,
    normalizedDownloadUrl: normalized.downloadUrl,
    normalizedOpenUrl: normalized.openUrl,
    keys: Object.keys(messageData || {}),
  }));
}

async function handleServerUpdateCommand(context, messageData = {}) {
  const normalized = extractUpdatePayload(messageData);
  const type = String(normalized.type || '').toLowerCase();
  const messageType = String(normalized.messageType || '').toLowerCase();
  logServerUpdateCommand(context, messageData, normalized, type, messageType);
  if (!isServerUpdateCommand(normalized, type, messageType)) return false;
  if (shouldIgnoreUpdateReceipt(normalized, messageType)) return false;
  const currentVersion = String(context.app.getVersion() || '').trim();
  const targetVersion = String(normalized.version || '').trim();
  if ((!normalized.downloadUrl && !normalized.openUrl) || !targetVersion) return true;
  if (compareVersions(currentVersion, targetVersion) >= 0) {
    emitUpdateEvent(context, 'app-update-skip', {
      ok: true, currentVersion, targetVersion, message: '当前已是最新版本',
    });
    return false;
  }
  emitUpdateEvent(context, 'app-update-notice', createUpdateUiPayload(normalized, {
    currentVersion, phase: 'notice',
  }));
  return false;
}

function createAppUpdater(deps = {}) {
  const context = createUpdaterContext(deps);
  return {
    compareVersions,
    extractUpdatePayload,
    cleanupUpdateStorageRoot,
    cleanupDownloadedArchive,
    startAppUpdate: (payload) => startAppUpdate(context, payload),
    handleServerUpdateCommand: (message) => handleServerUpdateCommand(context, message),
  };
}

module.exports = { createAppUpdater, cleanupUpdateStorageRoot };
