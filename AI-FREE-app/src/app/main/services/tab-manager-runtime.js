const { appContext } = require('../runtime/app-context');
const { toggleSidebarVisibility } = require('./tab-common');
const { createBrowserTutorialController } = require('../features/browser/browser-tutorial-controller');
const { createBrowserNetworkController } = require('../features/browser/browser-network-controller');
const { createBrowserTabLauncher } = require('../features/browser/browser-tab-launcher');
const { createBrowserRuntimeSettingsController } = require('../features/browser/browser-runtime-settings-controller');

function isUsableWebContents(webContents) {
  return Boolean(webContents) && !webContents.isDestroyed?.();
}

function focusMainWindowShell(mainWindow) {
  if (mainWindow && !mainWindow.isDestroyed?.() && !mainWindow.isFocused?.()) mainWindow.focus?.();
  if (isUsableWebContents(mainWindow?.webContents)) mainWindow.webContents.focus?.();
}

class TabManagerRuntime {
  constructor(deps = {}) {
    this.deps = deps;
    this.logger = deps.logger || console;
    this.closingTabIds = new Set();
    this.initializeTutorialController();
    this.initializeNetworkController();
    this.initializeTabLauncher();
    this.initializeSettingsController();
    this.registerRuntimeEvents();
  }

  resolveTabs() {
    return typeof this.deps.getTabs === 'function' ? this.deps.getTabs() : new Map();
  }

  resolveMainWindow() {
    return typeof this.deps.getMainWindow === 'function' ? this.deps.getMainWindow() : null;
  }

  resolveSideView() {
    return typeof this.deps.getSideView === 'function' ? this.deps.getSideView() : null;
  }

  resolveActiveTabId() {
    return typeof this.deps.getActiveTabId === 'function' ? this.deps.getActiveTabId() : null;
  }

  resolveIsSidebarVisible() {
    return typeof this.deps.getIsSidebarVisible === 'function' ? this.deps.getIsSidebarVisible() : true;
  }

  isSideViewFocused() {
    const webContents = this.resolveSideView()?.webContents;
    return Boolean(webContents && !webContents.isDestroyed?.() && webContents.isFocused?.());
  }

  restoreSideViewFocus() {
    const mainWindow = this.resolveMainWindow();
    const webContents = this.resolveSideView()?.webContents;
    if (!isUsableWebContents(webContents)) return false;
    try {
      const activeTabId = this.resolveActiveTabId();
      if (activeTabId) {
        this.deps.browserRuntimeManager?.releaseFocus?.(activeTabId, 'chromium');
      }
      focusMainWindowShell(mainWindow);
      webContents.focus();
      return true;
    } catch (_) {
      return false;
    }
  }

  hasPersistedChromiumProfile(profileId) {
    try {
      const runtimeStore = this.deps.browserRuntimeManager?.store;
      if (!runtimeStore || typeof runtimeStore.readProfile !== 'function') return false;
      const profile = runtimeStore.readProfile(String(profileId || ''));
      return Boolean(profile && typeof profile === 'object' && profile.createdAt);
    } catch (_) {
      return false;
    }
  }

  initializeTutorialController() {
    const controller = createBrowserTutorialController({
      addTab: (...args) => this.addTab(...args),
      browserRuntimeManager: this.deps.browserRuntimeManager,
      fs: this.deps.fs,
      getStorePath: this.deps.getStorePath,
      isSideViewFocused: () => this.isSideViewFocused(),
      licenseCache: this.deps.licenseCache,
      logger: this.logger,
      resolveTabs: () => this.resolveTabs(),
      restoreSideViewFocus: () => this.restoreSideViewFocus(),
      setActiveTabId: this.deps.setActiveTabId,
      switchTab: (...args) => this.switchTab(...args),
      updateTabs: this.deps.updateTabs,
    });
    this.ensureMinimumBrowserTab = controller.ensureMinimumBrowserTab;
    this.openTutorialTab = controller.openTutorialTab;
    this.resolveDefaultTabUrl = controller.resolveDefaultTabUrl;
    this.syncTutorialTabUrl = controller.syncTutorialTabUrl;
  }

  initializeNetworkController() {
    const controller = createBrowserNetworkController({
      browserRuntimeManager: this.deps.browserRuntimeManager,
      logger: this.logger,
      resolveTabs: () => this.resolveTabs(),
      updateTabs: this.deps.updateTabs,
    });
    this.applyClashMiniBrowserProxy = controller.applyClashMiniBrowserProxy;
    this.getBrowserProxyEndpoint = controller.getBrowserProxyEndpoint;
  }

  initializeTabLauncher() {
    const controller = createBrowserTabLauncher({
      browserRuntimeManager: this.deps.browserRuntimeManager,
      extensionManager: this.deps.extensionManager,
      getBrowserProxyEndpoint: this.getBrowserProxyEndpoint,
      hasPersistedChromiumProfile: (id) => this.hasPersistedChromiumProfile(id),
      isSideViewFocused: () => this.isSideViewFocused(),
      licenseCache: this.deps.licenseCache,
      logger: this.logger,
      readPersistedBrowserSettings: () => this.readPersistedBrowserSettings(),
      resolveActiveTabId: () => this.resolveActiveTabId(),
      resolveDefaultTabUrl: this.resolveDefaultTabUrl,
      resolveIsSidebarVisible: () => this.resolveIsSidebarVisible(),
      resolveMainWindow: () => this.resolveMainWindow(),
      resolveSideView: () => this.resolveSideView(),
      resolveTabBrowserProfile: this.deps.resolveTabBrowserProfile,
      resolveTabs: () => this.resolveTabs(),
      restoreSideViewFocus: () => this.restoreSideViewFocus(),
      sendToSide: this.deps.sendToSide,
      setActiveTabId: this.deps.setActiveTabId,
      switchTab: (...args) => this.switchTab(...args),
      updateTabs: this.deps.updateTabs,
    });
    this.addTab = controller.addTab;
  }

  initializeSettingsController() {
    const controller = createBrowserRuntimeSettingsController({
      browserRuntimeManager: this.deps.browserRuntimeManager,
      extensionManager: this.deps.extensionManager,
      getBrowserProxyEndpoint: this.getBrowserProxyEndpoint,
      logger: this.logger,
      resolveTabBrowserProfile: this.deps.resolveTabBrowserProfile,
      resolveTabs: () => this.resolveTabs(),
      sendToSide: this.deps.sendToSide,
      updateTabs: this.deps.updateTabs,
    });
    this.refreshBrowsersAfterExtensionChange = controller.refreshBrowsersAfterExtensionChange;
    this.setTabBrowserSettings = controller.setTabBrowserSettings;
  }

  registerRuntimeEvents() {
    const chromium = this.deps.browserRuntimeManager?.chromium;
    if (!chromium?.on) return;
    chromium.on('state-changed', (state) => this.handleRuntimeStateChanged(state));
    chromium.on('crashed', (state) => this.handleRuntimeCrash(state));
    chromium.on('runtime-event', (event) => this.handleRuntimeEvent(event));
  }

  handleRuntimeStateChanged(runtimeState) {
    const tab = this.resolveTabs().get(String(runtimeState?.profileId || ''));
    if (!tab) return;
    tab.runtimeStatus = runtimeState.status;
    tab.runtimeError = runtimeState.lastError || null;
    this.deps.updateTabs(true);
  }

  handleRuntimeCrash(runtimeState) {
    const tabId = String(runtimeState?.profileId || '');
    const tab = this.resolveTabs().get(tabId);
    if (!tab) return;
    tab.runtimeStatus = 'crashed';
    tab.runtimeError = runtimeState.lastError || null;
    this.deps.updateTabs(true);
    if (appContext.isShuttingDown()) return;
    setImmediate(() => this.closeCrashedTab(tabId));
  }

  closeCrashedTab(tabId) {
    if (appContext.isShuttingDown() || !this.resolveTabs().has(tabId) || this.closingTabIds.has(tabId)) return;
    void this.closeTab(tabId).catch((error) => {
      this.logger.warn?.('[ChromiumRuntime] 浏览器退出后关闭栏目失败:', error?.message || error);
    });
  }

  handleRuntimeEvent(event) {
    const tab = this.resolveTabs().get(String(event?.profileId || ''));
    if (!tab) return;
    if (event.type === 'title-changed') tab.runtimeTitle = String(event.title || '').trim();
    if (event.type === 'url-changed') tab.runtimeUrl = String(event.url || '').trim();
    this.deps.updateTabs();
  }

  readPersistedBrowserSettings() {
    try {
      const storePath = typeof this.deps.getStorePath === 'function' ? this.deps.getStorePath() : '';
      if (!storePath || !this.deps.fs?.existsSync?.(storePath)) return {};
      const store = JSON.parse(this.deps.fs.readFileSync(storePath, 'utf8') || '{}');
      return store.aiFreeBrowserSettings && typeof store.aiFreeBrowserSettings === 'object'
        ? store.aiFreeBrowserSettings
        : {};
    } catch (_) {
      return {};
    }
  }

  toggleSidebar() {
    return toggleSidebarVisibility({
      getIsSidebarVisible: () => this.resolveIsSidebarVisible(),
      setIsSidebarVisible: this.deps.setIsSidebarVisible,
      getMainWindow: () => this.resolveMainWindow(),
      getSideView: () => this.resolveSideView(),
    });
  }

  setTabAccountId(tabId, accountId) {
    try {
      const tabs = this.resolveTabs();
      if (!tabs.has(tabId)) return false;
      const tab = tabs.get(tabId);
      tab.accountId = String(accountId || '').trim();
      tabs.set(tabId, tab);
      this.deps.updateTabs(true);
      return true;
    } catch (_) {
      return false;
    }
  }

  switchTab(tabId, options = {}) {
    const tabs = this.resolveTabs();
    const mainWindow = this.resolveMainWindow();
    if (!mainWindow) return;
    if (!tabId) {
      this.showHomePage(tabs);
      return;
    }
    if (!tabs.has(tabId)) return;
    const activeTabId = this.resolveActiveTabId();
    if (activeTabId && tabs.has(activeTabId)) {
      void this.deps.browserRuntimeManager?.hide(tabs.get(activeTabId).id, 'chromium');
    }
    this.deps.setActiveTabId?.(tabId);
    const activeTab = tabs.get(tabId);
    void this.deps.browserRuntimeManager?.show(activeTab.id, 'chromium').then(() => (
      options.focusBrowser === true
        ? this.deps.browserRuntimeManager.focus(activeTab.id, 'chromium')
        : false
    )).catch((error) => {
      this.logger.warn?.('[ChromiumRuntime] 显示环境失败:', error?.message || error);
    });
    mainWindow.emit('resize');
    this.deps.updateTabs(true);
  }

  showHomePage(tabs = this.resolveTabs()) {
    const activeTabId = this.resolveActiveTabId();
    if (activeTabId && tabs.has(activeTabId)) {
      void this.deps.browserRuntimeManager?.hide(tabs.get(activeTabId).id, 'chromium');
    }
    this.deps.setActiveTabId?.(null);
    this.deps.updateTabs(true);
  }

  async closeTab(tabId) {
    const tabs = this.resolveTabs();
    if (!tabs.has(tabId) || !this.resolveMainWindow() || this.closingTabIds.has(tabId)) return;
    this.closingTabIds.add(tabId);
    try {
      const orderedTabIds = Array.from(tabs.keys());
      const tabToClose = tabs.get(tabId);
      await this.stopClosingTab(tabToClose);
      tabs.delete(tabId);
      this.notifyClosedAccount(tabId, tabToClose);
      await this.activateAfterClose(tabId, orderedTabIds, tabs);
      this.deps.updateTabs(true);
    } finally {
      this.closingTabIds.delete(tabId);
    }
  }

  async stopClosingTab(tab) {
    try {
      await this.deps.browserRuntimeManager?.stop(tab.id, 'chromium', { timeoutMs: 4000 });
    } catch (error) {
      this.logger.warn?.('[ChromiumRuntime] 关闭失败:', error?.message || error);
    }
  }

  notifyClosedAccount(tabId, tab) {
    const accountId = String(tab?.accountId || '').trim();
    if (!accountId) return;
    try { this.deps.sendToSide('tab-closed', { tabId, accountId }); } catch (_) {}
  }

  async activateAfterClose(tabId, orderedTabIds, tabs) {
    const remaining = Array.from(tabs.keys());
    if (!remaining.length) {
      this.deps.setActiveTabId?.(null);
      return;
    }
    if (this.resolveActiveTabId() !== tabId) return;
    const index = orderedTabIds.indexOf(tabId);
    const neighbors = [orderedTabIds[index - 1], orderedTabIds[index + 1]];
    this.switchTab(neighbors.find((id) => remaining.includes(id)) || remaining[0]);
  }

  reorderTab(tabId, targetTabId, position = 'before') {
    const tabs = this.resolveTabs();
    if (!tabId || !targetTabId || tabId === targetTabId) return false;
    if (!tabs.has(tabId) || !tabs.has(targetTabId)) return false;
    const entries = Array.from(tabs.entries()).filter(([id]) => id !== tabId);
    const targetIndex = entries.findIndex(([id]) => id === targetTabId);
    if (targetIndex === -1) return false;
    entries.splice(position === 'after' ? targetIndex + 1 : targetIndex, 0, [tabId, tabs.get(tabId)]);
    tabs.clear();
    for (const [id, tab] of entries) tabs.set(id, tab);
    this.deps.updateTabs(true);
    return true;
  }

  setZoom(zoomFactor) {
    const activeTab = this.resolveTabs().get(this.resolveActiveTabId());
    if (activeTab) activeTab.zoomFactor = zoomFactor;
    try { this.deps.sendToSide('active-zoom', zoomFactor); } catch (_) {}
  }

  async refreshActiveTabToUrl(url) {
    const activeTab = this.resolveTabs().get(this.resolveActiveTabId());
    if (!activeTab) return this.notifyMissingActiveTab();
    try {
      await this.deps.browserRuntimeManager.navigate(activeTab.id, 'chromium', url);
      this.deps.sendToSide('active-tab-refreshed', { ok: true, url, runtimeType: 'chromium' });
    } catch (error) {
      this.notifyRefreshError(error);
    }
  }

  async refreshActiveTab() {
    const activeTab = this.resolveTabs().get(this.resolveActiveTabId());
    if (!activeTab) return this.notifyMissingActiveTab();
    try {
      await this.deps.browserRuntimeManager.reload(activeTab.id, 'chromium');
      this.deps.sendToSide('active-tab-refreshed', { ok: true, runtimeType: 'chromium' });
    } catch (error) {
      this.notifyRefreshError(error);
    }
  }

  notifyMissingActiveTab() {
    this.logger.log?.('刷新', '没有激活标签页可刷新');
    this.deps.sendToSide('active-tab-refreshed', { ok: false, reason: 'no_active_tab' });
  }

  notifyRefreshError(error) {
    this.logger.log?.('刷新错误', error);
    this.deps.sendToSide('active-tab-refreshed', { ok: false, reason: error.message });
  }

  async refreshTab(tabId) {
    try {
      const tabs = this.resolveTabs();
      if (!tabs.has(tabId)) return { ok: false, message: '标签页不存在' };
      await this.deps.browserRuntimeManager.reload(tabs.get(tabId).id, 'chromium');
      if (tabId === this.resolveActiveTabId()) {
        try { this.deps.sendToSide('active-tab-refreshed', { ok: true, runtimeType: 'chromium' }); } catch (_) {}
      }
      return { ok: true };
    } catch (error) {
      this.logger.log?.('刷新错误', error);
      return { ok: false, message: error?.message || String(error) };
    }
  }

  renameTab(tabId, title) {
    try {
      const id = String(tabId || '').trim();
      const normalizedTitle = String(title || '').trim();
      if (!id || !normalizedTitle) return { ok: false, message: '浏览器名称不能为空' };
      const tabs = this.resolveTabs();
      const tab = tabs.get(id);
      if (!tab) return { ok: false, message: '浏览器窗口不存在' };
      tab.fixedTitle = normalizedTitle;
      tab.runtimeTitle = normalizedTitle;
      tabs.set(id, tab);
      this.deps.updateTabs(true);
      return { ok: true, tabId: id, title: normalizedTitle };
    } catch (error) {
      return { ok: false, message: error?.message || String(error) };
    }
  }

  getApi() {
    return {
      addTab: (...args) => this.addTab(...args),
      openTutorialTab: (...args) => this.openTutorialTab(...args),
      syncTutorialTabUrl: (...args) => this.syncTutorialTabUrl(...args),
      applyClashMiniBrowserProxy: (...args) => this.applyClashMiniBrowserProxy(...args),
      setTabBrowserSettings: (...args) => this.setTabBrowserSettings(...args),
      refreshBrowsersAfterExtensionChange: (...args) => this.refreshBrowsersAfterExtensionChange(...args),
      switchTab: (...args) => this.switchTab(...args),
      closeTab: (...args) => this.closeTab(...args),
      reorderTab: (...args) => this.reorderTab(...args),
      renameTab: (...args) => this.renameTab(...args),
      setTabAccountId: (...args) => this.setTabAccountId(...args),
      setZoom: (...args) => this.setZoom(...args),
      refreshActiveTabToUrl: (...args) => this.refreshActiveTabToUrl(...args),
      refreshActiveTab: () => this.refreshActiveTab(),
      refreshTab: (...args) => this.refreshTab(...args),
      toggleSidebar: () => this.toggleSidebar(),
    };
  }
}

function createTabManagerRuntime(deps) {
  return new TabManagerRuntime(deps).getApi();
}

module.exports = { createTabManagerRuntime };
