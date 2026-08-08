'use strict';

function bootstrapError(error) {
  return error?.message || error;
}

function initializeHttpAuth(deps) {
  try {
    if (!deps.resolveGlobalHttpClient()) {
      deps.setGlobalHttpClient?.(deps.createHttpClient({ mainWindow: null }));
    }
    const httpClient = deps.resolveGlobalHttpClient();
    deps.setAuth?.(deps.createAuthCookie({
      serverBase: deps.getServerBase(),
      httpClient,
      sendToSide: deps.sendToSide,
      licenseCache: deps.licenseCache,
    }));
  } catch (error) {
    deps.logger.warn?.('[启动] 初始化HTTP客户端/鉴权失败:', bootstrapError(error));
  }
}

function getConsoleHistory(deps, debug = false) {
  if (debug && typeof deps.getDebugConsoleHistory === 'function') return deps.getDebugConsoleHistory();
  return typeof deps.getAppConsoleHistory === 'function' ? deps.getAppConsoleHistory() : [];
}

function createBootstrapUiDeps(deps) {
  return {
    addTab: deps.resolveAddTab(),
    openTutorialTab: deps.resolveOpenTutorialTab(),
    syncTutorialTabUrl: deps.resolveSyncTutorialTabUrl(),
    switchTab: deps.resolveSwitchTab(),
    closeTab: deps.resolveCloseTab(),
    renameTab: deps.resolveRenameTab(),
    setTabAccountId: deps.resolveSetTabAccountId(),
    setTabBrowserSettings: deps.resolveSetTabBrowserSettings(),
    updateTabs: deps.updateTabs,
    getTabs: () => deps.resolveTabs(),
    getActiveTabId: () => deps.resolveActiveTabId(),
    getActiveWC: deps.getActiveWC,
    refreshTab: deps.resolveRefreshTab(),
    reorderTab: deps.resolveReorderTab(),
    setZoom: deps.resolveSetZoom(),
    refreshActiveTabToUrl: deps.resolveRefreshActiveTabToUrl(),
    refreshActiveTab: deps.resolveRefreshActiveTab(),
    toggleSidebar: deps.toggleSidebar,
    setSidebarWidth: deps.setSidebarWidth,
    sendToSide: deps.sendToSide,
    startAppUpdate: deps.startAppUpdate,
    getAppVersion: deps.getAppVersion,
    getMainWindow: () => deps.resolveMainWindow(),
    getSideView: () => deps.resolveSideView(),
    applyPluginSettings: deps.applyPluginSettings,
    extensionManager: deps.extensionManager,
    statePluginGetter: deps.statePluginGetter,
    setRuntimeTcpConfig: deps.setRuntimeTcpConfig,
    setRuntimeServerBase: deps.setRuntimeServerBase,
    getAppConsoleHistory: () => getConsoleHistory(deps),
    getDebugConsoleHistory: () => getConsoleHistory(deps, true),
    ensureSidebarVisible: () => { if (!deps.getIsSidebarVisible?.()) deps.toggleSidebar(); },
    purgeBrowserSessionData: typeof deps.purgeBrowserSessionData === 'function' ? deps.purgeBrowserSessionData : null,
    buildManagedTabPartitionName: typeof deps.buildManagedTabPartitionName === 'function' ? deps.buildManagedTabPartitionName : null,
    applyClashMiniBrowserProxy: typeof deps.applyClashMiniBrowserProxy === 'function' ? deps.applyClashMiniBrowserProxy : null,
    browserRuntimeManager: deps.browserRuntimeManager || null,
  };
}

function registerBootstrapIPC(deps) {
  try {
    const runtimeConfig = deps.licenseCache?.getRuntimeConfig?.() || {};
    deps.registerIPC({
      app: deps.app,
      dialog: deps.dialog,
      DREAM_TARGET_URL: runtimeConfig.targetUrl || deps.DREAM_TARGET_URL,
      getDreamTargetUrl: () => deps.getDreamTargetUrl(),
      http: { postJson: deps.postJson, getJson: deps.getJson, httpGetUniversal: deps.httpGetUniversal },
      httpClient: deps.resolveGlobalHttpClient(),
      extensionManager: deps.extensionManager,
      loadTranslateExtension: deps.loadTranslateExtension,
      ui: createBootstrapUiDeps(deps),
      auth: deps.resolveAuth(),
      log: deps.log,
      state: deps.state,
      licenseCache: deps.licenseCache,
      computeDeviceId: deps.computeDeviceId,
      appendLicenseRecord: typeof deps.appendLicenseRecord === 'function' ? deps.appendLicenseRecord : null,
      refreshAllowedPlatformsAndNotify: typeof deps.refreshAllowedPlatformsAndNotify === 'function'
        ? deps.refreshAllowedPlatformsAndNotify
        : null,
      refreshAnnouncements: (options = {}) => deps.ensureAnnouncementPoller().refreshNow(options),
      getCurrentPlatformLabel: deps.getCurrentPlatformLabel,
      readStoreConfigSafe: deps.readStoreConfigSafe,
      writeStoreConfigSafe: deps.writeStoreConfigSafe,
    });
    deps.logger.log?.('[启动] IPC handlers 已注册');
  } catch (error) {
    deps.logger.error?.('[启动] 注册 IPC 失败:', bootstrapError(error));
  }
}

function createBootstrapWindows(deps) {
  try {
    deps.createMainWindow();
    if (!deps.isControlPanelOnlyModeEnabled()) deps.revealMainWindow();
  } catch (error) {
    deps.logger.warn?.('[启动] 创建主窗口失败:', bootstrapError(error));
  }
  if (!deps.isDevMode) return;
  try { deps.createDevConsoleWindow(); }
  catch (error) { deps.logger.warn?.('[启动] 创建调试控制台窗口失败:', bootstrapError(error)); }
}

async function refreshBootstrapRuntimeUrls(deps, state) {
  if (state.runtimeUrlRefreshInFlight) return;
  state.runtimeUrlRefreshInFlight = true;
  try {
    const httpClient = deps.resolveGlobalHttpClient();
    if (typeof httpClient?.getTutorialUrl === 'function') {
      const response = await httpClient.getTutorialUrl();
      const tutorialUrl = String(response?.tutorialUrl || response?.tutorial_url || '').trim();
      if (response?.ok === true && tutorialUrl) {
        deps.licenseCache?.setRuntimeConfig?.({ tutorialUrl });
        deps.sendToSide('tutorial-url-updated', { tutorialUrl });
      }
    }
    if (typeof deps.refreshAllowedPlatformsAndNotify === 'function') {
      await deps.refreshAllowedPlatformsAndNotify();
    }
  } finally {
    state.runtimeUrlRefreshInFlight = false;
  }
}

async function initializeBootstrapExtensions(deps) {
  try {
    if (typeof deps.extensionManager?.initialize === 'function') {
      await deps.extensionManager.initialize({ emit: true });
    } else {
      deps.applyPluginSettings({ translateExtEnabled: false });
    }
  } catch (error) {
    deps.logger.warn?.('[启动] 初始化插件开关失败，使用默认值:', bootstrapError(error));
    deps.applyPluginSettings({ translateExtEnabled: false });
  }
}

async function initializeBootstrapAccountCleanup(deps) {
  if (typeof deps.initializeAccountCleanup !== 'function') return;
  try {
    await deps.initializeAccountCleanup(deps.accountStorage, {
      sendToSide: deps.sendToSide,
      cleanupAccountArtifacts: (accountId) => deps.cleanupAccountProfile(accountId, {
        browserRuntimeManager: deps.browserRuntimeManager,
        getTabs: () => deps.resolveTabs(),
        closeTab: deps.resolveCloseTab(),
        fs: deps.fs,
        getStorePath: deps.getStorePath,
        sendToSide: deps.sendToSide,
        logger: deps.logger,
      }),
    });
  } catch (error) {
    deps.logger.warn?.('[启动] 刷新账号回收定时器失败:', bootstrapError(error));
  }
}

async function cleanupResidualTabPartitions(deps) {
  try {
    const userDataDir = deps.app.getPath('userData');
    const entries = await deps.fs.promises.readdir(userDataDir).catch(() => []);
    const inUse = new Set(Array.from(deps.resolveTabs().values())
      .map((tab) => String(tab?.partition || '').replace(/^persist:/, ''))
      .filter(Boolean));
    for (const name of entries) {
      if (!/^tab-\d+$/.test(name) || inUse.has(name)) continue;
      const dirPath = deps.path.join(userDataDir, name);
      const stat = await deps.fs.promises.stat(dirPath).catch(() => null);
      if (!stat?.isDirectory()) continue;
      const deleted = await deps.removeDirectoryWithRetries(deps.fs, dirPath);
      if (!deleted) deps.logger.warn?.('[启动] 删除残留分区最终失败（跳过）:', dirPath);
    }
  } catch (error) {
    deps.logger.warn?.('[启动] 启动时清理残留分区失败:', bootstrapError(error));
  }
}

async function runBootstrapBackgroundTasks(deps, state) {
  try {
    await new Promise((resolve) => setImmediate(resolve));
    await initializeBootstrapExtensions(deps);
    try { await refreshBootstrapRuntimeUrls(deps, state); }
    catch (error) { deps.logger.warn?.('[启动] 获取URL配置失败:', bootstrapError(error)); }
    await initializeBootstrapAccountCleanup(deps);
    await cleanupResidualTabPartitions(deps);
  } catch (error) {
    deps.logger.warn?.('[启动] 初始化后台任务失败:', bootstrapError(error));
  }
}

async function bootstrapMainApp(deps, state) {
  if (deps.resolveIsMainBootstrapped()) {
    const mainWindow = deps.resolveMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      deps.createMainWindow();
      deps.revealMainWindow();
    }
    return;
  }
  deps.setIsMainBootstrapped?.(true);
  initializeHttpAuth(deps);
  registerBootstrapIPC(deps);
  try { deps.ensureAnnouncementPoller().start(); }
  catch (error) { deps.logger.warn?.('[启动] 启动公告轮询失败:', bootstrapError(error)); }
  createBootstrapWindows(deps);
  void runBootstrapBackgroundTasks(deps, state).catch((error) => {
    deps.logger.warn?.('[启动] 后台初始化任务失败:', bootstrapError(error));
  });
  deps.initDownloadPrefs();
  const httpClient = deps.resolveGlobalHttpClient();
  if (httpClient) httpClient.mainWindow = deps.resolveMainWindow();
}

function createAppShellBootstrap(deps = {}) {
  const state = { runtimeUrlRefreshInFlight: false };
  return () => bootstrapMainApp(deps, state);
}

module.exports = { createAppShellBootstrap };
