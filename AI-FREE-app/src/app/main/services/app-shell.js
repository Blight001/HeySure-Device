const { createAnnouncementPoller } = require('../lib/announcement-poller');
const { removeDirectoryWithRetries } = require('../utils/fs-cleanup');
const { cleanupAccountProfile } = require('./account-profile-cleanup');
const { createAppShellBootstrap } = require('./app-shell-bootstrap');
const { createAppShellMainWindowController } = require('./app-shell-main-window');

class AppShellRuntime {
  constructor(deps = {}) {
    this.deps = /** @type {Record<string, any>} */ ({ logger: console, ...deps });
    this.controlPanelWindow = null;
    this.announcementPoller = null;
    this.sideAnnouncementReady = false;
    this.initializeControllers();
  }

  resolveDependency(name, fallback = null) {
    const getter = this.deps[name];
    return typeof getter === 'function' ? getter() : fallback;
  }

  resolveAction(name) {
    return this.resolveDependency(name, null);
  }

  resolveMainWindow() { return this.resolveDependency('getMainWindow'); }
  resolveSideView() { return this.resolveDependency('getSideView'); }
  resolveExtPopupWin() { return this.resolveDependency('getExtPopupWin'); }
  resolveTabs() { return this.resolveDependency('getTabs', new Map()); }
  resolveActiveTabId() { return this.resolveDependency('getActiveTabId'); }
  resolveAuth() { return this.resolveDependency('getAuth', this.deps.auth); }
  resolveGlobalHttpClient() { return this.resolveDependency('getGlobalHttpClient'); }
  resolveIsMainBootstrapped() { return this.resolveDependency('getIsMainBootstrapped', false); }
  resolveAddTab() { return this.resolveAction('getAddTab'); }
  resolveOpenTutorialTab() { return this.resolveAction('getOpenTutorialTab'); }
  resolveSyncTutorialTabUrl() { return this.resolveAction('getSyncTutorialTabUrl'); }
  resolveSwitchTab() { return this.resolveAction('getSwitchTab'); }
  resolveCloseTab() { return this.resolveAction('getCloseTab'); }
  resolveReorderTab() { return this.resolveAction('getReorderTab'); }
  resolveRenameTab() { return this.resolveAction('getRenameTab'); }
  resolveSetTabAccountId() { return this.resolveAction('getSetTabAccountId'); }
  resolveSetTabBrowserSettings() { return this.resolveAction('getSetTabBrowserSettings'); }
  resolveSetZoom() { return this.resolveAction('getSetZoom'); }
  resolveRefreshActiveTabToUrl() { return this.resolveAction('getRefreshActiveTabToUrl'); }
  resolveRefreshActiveTab() { return this.resolveAction('getRefreshActiveTab'); }
  resolveRefreshTab() { return this.resolveAction('getRefreshTab'); }

  resolveControlPanelWindow() {
    return this.resolveDependency('getControlPanelWindow', this.controlPanelWindow);
  }

  sendAnnouncementToSide(channel, payload) {
    try {
      const webContents = this.resolveSideView()?.webContents;
      if (!this.sideAnnouncementReady || !webContents || webContents.isDestroyed()) return false;
      if (typeof webContents.isLoadingMainFrame === 'function' && webContents.isLoadingMainFrame()) return false;
      webContents.send(channel, payload);
      return true;
    } catch (_) { return false; }
  }

  getLicenseSnapshot() {
    try {
      return typeof this.deps.licenseCache?.getSnapshot === 'function'
        ? this.deps.licenseCache.getSnapshot() : null;
    } catch (_) { return null; }
  }

  canPollAnnouncements() {
    return this.getLicenseSnapshot()?.validated === true;
  }

  getAnnouncementClientIdentity() {
    const snapshot = this.getLicenseSnapshot();
    return { key: snapshot?.key || '', deviceId: snapshot?.deviceId || '' };
  }

  async sendUpdateNotice(payload) {
    if (typeof this.deps.handleServerUpdateCommand !== 'function') {
      return this.sendAnnouncementToSide('app-update-notice', payload);
    }
    await this.deps.handleServerUpdateCommand(payload);
    return true;
  }

  ensureAnnouncementPoller() {
    if (this.announcementPoller) return this.announcementPoller;
    this.announcementPoller = createAnnouncementPoller({
      getJson: this.deps.getJson,
      postJson: this.deps.postJson,
      getServerBase: this.deps.getServerBase,
      getClientIdentity: this.getAnnouncementClientIdentity.bind(this),
      shouldPoll: this.canPollAnnouncements.bind(this),
      sendToSide: this.sendAnnouncementToSide.bind(this),
      sendUpdateNotice: this.sendUpdateNotice.bind(this),
      logger: this.deps.logger,
    });
    return this.announcementPoller;
  }

  hasModeArgument(values) {
    return process.argv.some((argument) => values.includes(String(argument || '').trim().toLowerCase()));
  }

  hasEnabledEnvironmentValue(name) {
    return ['1', 'true'].includes(String(process.env[name] || '').trim().toLowerCase());
  }

  isControlPanelModeEnabled() {
    const bootMode = String(process.env.APP_BOOT_MODE || '').trim().toLowerCase();
    return this.hasModeArgument(['--control-panel', '--control-panel-only'])
      || ['control-panel', 'control-panel-only'].includes(bootMode)
      || this.hasEnabledEnvironmentValue('CONTROL_PANEL_MODE');
  }

  isControlPanelOnlyModeEnabled() {
    return this.hasModeArgument(['--control-panel-only'])
      || String(process.env.APP_BOOT_MODE || '').trim().toLowerCase() === 'control-panel-only'
      || this.hasEnabledEnvironmentValue('CONTROL_PANEL_ONLY');
  }

  resolveControlPanelHtmlPath(fileName = 'ai-control.html') {
    const { app, fs, path } = this.deps;
    const candidates = [
      path.join(__dirname, '../../sidebar', fileName),
      path.join(app.getAppPath ? app.getAppPath() : '', 'src', 'app', 'sidebar', fileName),
      path.join(process.cwd(), 'src', 'app', 'sidebar', fileName),
    ].filter(Boolean);
    for (const candidate of candidates) {
      try { if (fs.existsSync(candidate)) return candidate; } catch (_) {}
    }
    return null;
  }

  resolveAppIconPath() {
    if (typeof this.deps.resolveAppIconPath === 'function') return this.deps.resolveAppIconPath();
    return this.deps.path.join(__dirname, '../../../', this.deps.FIXED_ICON_RELATIVE_PATH);
  }

  createShellWindow(options) {
    return new this.deps.BrowserWindow({
      icon: this.resolveAppIconPath(), show: false, frame: true, titleBarStyle: 'default',
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false, contextIsolation: true,
        preload: this.deps.path.join(__dirname, '../preload.js'),
      },
      ...options,
    });
  }

  removeWindowMenu(window, label) {
    try {
      window.setMenu(null);
      window.setMenuBarVisibility(false);
    } catch (error) {
      this.deps.logger.warn?.(`[启动] ${label}菜单清理失败:`, error?.message || error);
    }
  }

  showWindowWhenReady(window, label, focus = false) {
    window.once('ready-to-show', () => {
      try {
        if (window.isDestroyed()) return;
        window.show();
        if (focus) window.focus();
      } catch (error) {
        this.deps.logger.warn?.(`[启动] ${label}显示失败:`, error?.message || error);
      }
    });
  }

  logWindowLoadFailure(window, label, extra = {}) {
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      this.deps.logger.warn?.(`[启动] ${label}加载失败:`, { errorCode, errorDescription, validatedURL, ...extra });
    });
  }

  revealExistingControlPanel(window) {
    try {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    } catch (_) {}
    return window;
  }

  createControlPanelWindow() {
    if (!this.isControlPanelModeEnabled()) return null;
    const existing = this.resolveControlPanelWindow();
    if (existing && !existing.isDestroyed()) return this.revealExistingControlPanel(existing);
    const window = this.createShellWindow({
      width: 1460, height: 1040, minWidth: 1200, minHeight: 800,
      title: `${this.deps.APP_DISPLAY_NAME} - 控制页`, backgroundColor: '#0c1016',
    });
    this.controlPanelWindow = window;
    this.deps.setControlPanelWindow?.(window);
    this.removeWindowMenu(window, '控制页窗口');
    const htmlPath = this.resolveControlPanelHtmlPath();
    if (!htmlPath) return this.closeMissingControlPanel(window);
    window.loadFile(htmlPath, { query: { dev: this.deps.isDevMode ? '1' : '0' } });
    this.showWindowWhenReady(window, '控制页窗口', true);
    window.on('closed', () => this.clearControlPanelWindow());
    this.logWindowLoadFailure(window, '控制页', { controlPanelPath: htmlPath });
    return window;
  }

  closeMissingControlPanel(window) {
    this.deps.logger.warn?.('[启动] 未找到本地 src/app/sidebar/ai-control.html，跳过控制页窗口加载');
    try { window.close(); } catch (_) {}
    return null;
  }

  clearControlPanelWindow() {
    this.controlPanelWindow = null;
    this.deps.setControlPanelWindow?.(null);
  }

  initializeControllers() {
    const mainController = createAppShellMainWindowController({
      ...this.deps,
      canPollAnnouncements: this.canPollAnnouncements.bind(this),
      createControlPanelWindow: this.createControlPanelWindow.bind(this),
      ensureAnnouncementPoller: this.ensureAnnouncementPoller.bind(this),
      isControlPanelModeEnabled: this.isControlPanelModeEnabled.bind(this),
      resolveActiveTabId: this.resolveActiveTabId.bind(this),
      resolveAddTab: this.resolveAddTab.bind(this),
      resolveAuth: this.resolveAuth.bind(this),
      resolveControlPanelHtmlPath: this.resolveControlPanelHtmlPath.bind(this),
      resolveControlPanelWindow: this.resolveControlPanelWindow.bind(this),
      resolveMainWindow: this.resolveMainWindow.bind(this),
      resolveRefreshActiveTab: this.resolveRefreshActiveTab.bind(this),
      resolveTabs: this.resolveTabs.bind(this),
      setSideAnnouncementReady: (value) => { this.sideAnnouncementReady = value; },
    });
    this.createMainWindow = mainController.createMainWindow;
    this.revealMainWindow = mainController.revealMainWindow;
    this.setSidebarWidth = mainController.setSidebarWidth;
    this.bootstrapMainApp = this.createBootstrapMainApp();
  }

  createBootstrapMainApp() {
    return createAppShellBootstrap({
      ...this.deps,
      cleanupAccountProfile,
      removeDirectoryWithRetries,
      createMainWindow: this.createMainWindow,
      ensureAnnouncementPoller: this.ensureAnnouncementPoller.bind(this),
      isControlPanelOnlyModeEnabled: this.isControlPanelOnlyModeEnabled.bind(this),
      revealMainWindow: this.revealMainWindow,
      setSidebarWidth: this.setSidebarWidth,
      resolveActiveTabId: this.resolveActiveTabId.bind(this),
      resolveAddTab: this.resolveAddTab.bind(this),
      resolveAuth: this.resolveAuth.bind(this),
      resolveCloseTab: this.resolveCloseTab.bind(this),
      resolveGlobalHttpClient: this.resolveGlobalHttpClient.bind(this),
      resolveIsMainBootstrapped: this.resolveIsMainBootstrapped.bind(this),
      resolveMainWindow: this.resolveMainWindow.bind(this),
      resolveOpenTutorialTab: this.resolveOpenTutorialTab.bind(this),
      resolveRefreshActiveTab: this.resolveRefreshActiveTab.bind(this),
      resolveRefreshActiveTabToUrl: this.resolveRefreshActiveTabToUrl.bind(this),
      resolveRefreshTab: this.resolveRefreshTab.bind(this),
      resolveRenameTab: this.resolveRenameTab.bind(this),
      resolveReorderTab: this.resolveReorderTab.bind(this),
      resolveSetTabAccountId: this.resolveSetTabAccountId.bind(this),
      resolveSetTabBrowserSettings: this.resolveSetTabBrowserSettings.bind(this),
      resolveSetZoom: this.resolveSetZoom.bind(this),
      resolveSideView: this.resolveSideView.bind(this),
      resolveSwitchTab: this.resolveSwitchTab.bind(this),
      resolveSyncTutorialTabUrl: this.resolveSyncTutorialTabUrl.bind(this),
      resolveTabs: this.resolveTabs.bind(this),
    });
  }

  refreshAnnouncements() {
    return this.ensureAnnouncementPoller().refreshNow();
  }
}

function createAppShell(deps = {}) {
  const runtime = new AppShellRuntime(deps);
  return {
    bootstrapMainApp: runtime.bootstrapMainApp,
    createMainWindow: runtime.createMainWindow,
    revealMainWindow: runtime.revealMainWindow,
    refreshAnnouncements: runtime.refreshAnnouncements.bind(runtime),
  };
}

module.exports = { createAppShell };
