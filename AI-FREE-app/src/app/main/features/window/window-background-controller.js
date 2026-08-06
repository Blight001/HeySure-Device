'use strict';

const {
  readWindowCloseBehavior,
  writeWindowCloseBehavior,
} = require('./window-close-preference');

const HIDE_RESPONSE = 0;
const QUIT_RESPONSE = 1;

function isUsableWindow(window) {
  return Boolean(window && !window.isDestroyed?.());
}

class WindowBackgroundController {
  constructor(deps = {}) {
    this.deps = deps;
    this.tray = null;
    this.boundWindow = null;
    this.closePrompt = null;
    this.quitting = false;
    this.handleBeforeQuit = () => { this.quitting = true; };
    this.handleWillQuit = () => this.dispose();
    deps.app?.on?.('before-quit', this.handleBeforeQuit);
    deps.app?.once?.('will-quit', this.handleWillQuit);
  }

  resolveWindow() {
    const current = this.deps.resolveMainWindow?.();
    return isUsableWindow(current) ? current : this.boundWindow;
  }

  revealWindow() {
    const window = this.resolveWindow();
    if (!isUsableWindow(window)) return false;
    if (window.isMinimized?.()) window.restore?.();
    window.show?.();
    window.focus?.();
    return true;
  }

  requestQuit() {
    if (this.quitting) return;
    this.quitting = true;
    this.deps.app?.quit?.();
  }

  createTray() {
    if (this.tray && !this.tray.isDestroyed?.()) return this.tray;
    this.tray = this.buildTray();
    return this.tray;
  }

  buildTray() {
    try {
      const iconPath = this.deps.resolveAppIconPath?.();
      const tray = new this.deps.Tray(iconPath);
      tray.setToolTip?.(this.deps.APP_DISPLAY_NAME || 'AI-FREE');
      tray.on?.('click', () => this.revealWindow());
      const menu = this.deps.Menu?.buildFromTemplate?.([
        { label: '显示 AI-FREE', click: () => this.revealWindow() },
        { type: 'separator' },
        { label: '退出 AI-FREE', click: () => this.requestQuit() },
      ]);
      if (menu) tray.setContextMenu?.(menu);
      return tray;
    } catch (error) {
      this.deps.logger?.warn?.('[Tray] 创建系统托盘失败:', error?.message || error);
      return null;
    }
  }

  async promptClose(window) {
    const result = await this.deps.dialog.showMessageBox(window, {
      type: 'question',
      title: this.deps.APP_DISPLAY_NAME || 'AI-FREE',
      message: '关闭 AI-FREE',
      detail: '隐藏窗口后，浏览器和自动化任务会继续在后台运行。',
      buttons: ['隐藏窗口', '退出软件'],
      defaultId: HIDE_RESPONSE,
      cancelId: HIDE_RESPONSE,
      checkboxLabel: '记住当前选择，下次不再提示',
      checkboxChecked: false,
      noLink: true,
    });
    const choice = result?.response === QUIT_RESPONSE ? 'quit' : 'hide';
    if (result?.checkboxChecked === true) {
      const saved = writeWindowCloseBehavior(
        this.deps.readStoreConfigSafe,
        this.deps.writeStoreConfigSafe,
        choice,
      );
      if (!saved.ok) {
        this.deps.logger?.warn?.('[Tray] 保存窗口关闭方式失败:', saved.error?.message);
      }
    }
    return choice;
  }

  applyCloseChoice(window, choice) {
    if (choice === 'quit') {
      this.requestQuit();
    } else if (this.createTray()) {
      window.hide?.();
    }
  }

  async handleCloseChoice(window) {
    try {
      const savedChoice = readWindowCloseBehavior(this.deps.readStoreConfigSafe);
      const choice = savedChoice === 'ask' ? await this.promptClose(window) : savedChoice;
      if (this.quitting || !isUsableWindow(window)) return;
      this.applyCloseChoice(window, choice);
    } catch (error) {
      this.deps.logger?.warn?.('[Tray] 显示关闭选项失败:', error?.message || error);
    }
  }

  handleWindowClose(event, window) {
    if (this.quitting) return;
    event?.preventDefault?.();
    if (this.closePrompt) return;
    this.closePrompt = this.handleCloseChoice(window)
      .finally(() => { this.closePrompt = null; });
  }

  bindWindow(window) {
    if (!isUsableWindow(window)) return;
    this.boundWindow = window;
    this.createTray();
    window.on?.('close', (event) => this.handleWindowClose(event, window));
    window.once?.('closed', () => {
      if (this.boundWindow === window) this.boundWindow = null;
    });
  }

  dispose() {
    try { this.tray?.destroy?.(); } catch (_) {}
    this.tray = null;
    this.deps.app?.removeListener?.('before-quit', this.handleBeforeQuit);
  }
}

function createWindowBackgroundController(deps = {}) {
  return new WindowBackgroundController(deps);
}

module.exports = {
  HIDE_RESPONSE,
  QUIT_RESPONSE,
  WindowBackgroundController,
  createWindowBackgroundController,
};
