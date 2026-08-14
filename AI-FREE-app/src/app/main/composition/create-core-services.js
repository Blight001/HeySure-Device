// 核心服务装配（阶段 2D-3，自 bootstrap.js 原样迁出）：
// 按依赖顺序创建主进程各服务实例。仅 tabManager 相关函数是晚绑定
// （由 bootstrap 在 createTabManager 后回填），经 getTabManager 访问。
'use strict';

const { createAppState } = require('../runtime/app-state');
const { createLicenseCache } = require('../runtime/license-cache');
const { createUiBridge } = require('./create-ui-bridge');
const { createAppUpdater } = require('../services/app-updater');
const { createBrowserRuntimeManager } = require('../browser-runtime');
const { createLogger } = require('../utils/logger');
const { createBrowserPartitionCleaner } = require('../services/browser-partitions');
const { createBrowserAutomationBridge } = require('../services/browser-automation-bridge');
const { createBrowserDownloadService } = require('../services/browser-download-service');
const { createAiServerDeviceService } = require('../features/ai-chat/ai-server-device-service');
const { createHeySureFileMaterializer } = require('../features/ai-chat/heysure-file-materializer');
const { createHeySureFileUploader } = require('../features/ai-chat/heysure-file-uploader');
const { createAiServerDeviceCredentialStore } = require('../features/ai-chat/ai-server-device-credential-store');
const { createLicenseStore } = require('../services/license-store');
const { createServerResolver } = require('../services/server-resolver');
const { createTabHelpers } = require('../services/tab-helpers');
const { createRuntimeHelpers } = require('../services/runtime-helpers');
const { createSystemResourceMonitor } = require('../platform/system-resource-monitor');
const { createBrowserLaunchGuard } = require('../features/browser/browser-launch-guard');
const { createBackgroundExecutionLeaseManager } = require('../platform/background-execution-lease');
const { createExtensionManager } = require('../services/extension-manager');
const { getHardwareFingerprint } = require('../utils/hardware-js');
const { resolveVipAccess } = require('../utils/vip-access');
const { readBrowserHistorySafe, serializeBrowserHistory } = require('../features/browser/browser-history-service');
const { extractValidationState, getValidationFailureMessage } = require('../utils/license-response');
const { postJson, getJson, httpGetUniversal } = require('../lib/http');
const { normalizeValidationRuntimeConfig } = require('../lib/http-client');
const accountStorage = require('../lib/account-storage');
const {
  getStorePath,
  getServerBase,
  setRuntimeTcpConfig,
  setRuntimeServerBase,
} = require('../config');
const {
  resolveAiSandboxDir,
  resolveAutomationCardCacheDir,
  resolveChromiumResourcesPath,
} = require('../config/paths');

const APP_DISPLAY_NAME = 'AI-FREE';

function createCoreServices({ app, fs, path, BrowserWindow, powerSaveBlocker, safeStorage, safeModePolicy, getTabManager }) {
  // ---- 全局状态 ----
  const appRuntime = createAppState();
  const tabs = appRuntime.tabs;

  const aiSandboxDir = resolveAiSandboxDir(app);
  try {
    fs.mkdirSync(aiSandboxDir, { recursive: true });
  } catch (error) {
    console.warn('[AI工作区] 无法创建安装目录工作区:', error?.message || error);
  }
  const browserRuntimeManager = createBrowserRuntimeManager({
    userDataDir: app.getPath('userData'),
    resourcesPath: resolveChromiumResourcesPath(app),
    sandboxDir: aiSandboxDir,
    appVersion: app.getVersion(),
    getParentWindow: appRuntime.getMainWindow,
    logger: console,
  });
  const systemResourceMonitor = createSystemResourceMonitor({
    fs,
    profileRoot: app.getPath('userData'),
    getActiveProfiles: () => browserRuntimeManager.listStates()
      .filter((state) => !['stopped', 'crashed'].includes(String(state?.status || ''))).length,
    logger: console,
  });
  const browserLaunchGuard = createBrowserLaunchGuard({ resourceMonitor: systemResourceMonitor });
  try {
    if (process.platform === 'win32' && browserRuntimeManager.isChromiumAvailable()) {
      browserRuntimeManager.windowBridge.setPerMonitorDpiAwareness();
    }
  } catch (error) {
    console.warn('[ChromiumRuntime] 无法初始化 Per-Monitor DPI V2:', error?.message || error);
  }
  app.whenReady().then(async () => {
    systemResourceMonitor.start();
    if (safeModePolicy?.preflightWarmup === false) {
      console.warn('[SafeMode] 已跳过 Chromium 后台预检');
      return;
    }
    const snapshot = await systemResourceMonitor.getSnapshot({ force: true });
    if (snapshot.pressure === 'critical') {
      console.warn('[BrowserCapacity] 资源严重不足，跳过 Chromium 后台预检');
      return;
    }
    await browserRuntimeManager.prewarmChromium();
  }).catch((error) => {
    console.warn('[ChromiumRuntime] 无法启动后台预检:', error?.message || error);
  });
  app.once('will-quit', () => systemResourceMonitor.stop());

  const licenseCache = createLicenseCache();
  if (typeof accountStorage.setLicenseCache === 'function') {
    accountStorage.setLicenseCache(licenseCache);
  }
  const backgroundExecutionLeases = createBackgroundExecutionLeaseManager({
    powerSaveBlocker,
    logger: console,
  });
  app.once('will-quit', () => backgroundExecutionLeases.dispose());
  const getBrowserCapacity = () => {
    const access = resolveVipAccess(licenseCache.getSnapshot?.() || {});
    return browserLaunchGuard.evaluate({
      productLimit: access.isVip ? 8 : 5,
      administratorLimit: licenseCache.getRuntimeConfig?.().browserCapacityLimit,
    });
  };

  const browserPartitionCleaner = createBrowserPartitionCleaner({
    app,
    fs,
    path,
    BrowserWindow,
    getTabs: () => tabs,
    getMainWindow: appRuntime.getMainWindow,
    getSideView: appRuntime.getSideView,
    getLicenseWindow: appRuntime.getLicenseWindow,
    getActiveTabId: appRuntime.getActiveTabId,
    getExtPopupWin: appRuntime.getExtPopupWin,
    logger: console,
    licenseCache,
  });

  // 应用状态（统一通过 state 对象管理，便于注入到 IPC）
  const state = {
    // 当用户选择"使用自定义代理"时置为 true，后续不再为网页强制挂本地端口代理
    manualProxyPreferred: false,
    pluginSettings: appRuntime.getPluginSettings(),
  };
  function applyPluginSettings(partial = {}) {
    state.pluginSettings = appRuntime.applyPluginSettings(partial);
  }

  // 日志封装（侧栏转发通过 sideView.webContents）
  const logger = createLogger({ getSideWebContents: () => (appRuntime.getSideView() && appRuntime.getSideView().webContents) || null });

  const browserAutomationBridge = createBrowserAutomationBridge({
    backgroundExecutionLeases,
    logger: console,
    cardCacheDir: resolveAutomationCardCacheDir(app),
    browserDownloadService: createBrowserDownloadService({ sandboxDir: aiSandboxDir }),
    browserRuntimeManager,
    workspaceDir: aiSandboxDir,
    getBrowserRecords: () => serializeBrowserHistory(readBrowserHistorySafe(), {
      getTabs: () => tabs, getActiveTabId: appRuntime.getActiveTabId,
    }),
    getTabs: () => tabs,
    getActiveBrowserProfileId: appRuntime.getActiveTabId,
    externalMcpDescriptorPath: path.join(app.getPath('userData'), 'ai-free-mcp-bridge.json'),
    getExternalMcpAccess: () => resolveVipAccess(licenseCache.getSnapshot()),
  });
  licenseCache.subscribe?.(() => {
    try { browserAutomationBridge.refreshExternalMcpAccess(); } catch (error) {
      console.warn('[ExternalMCP] 刷新会员权限失败:', error?.message || error);
    }
  });
  app.whenReady().then(() => browserAutomationBridge.start()).catch((error) => {
    console.error('[AutomationBridge] 启动失败:', error?.message || error);
  });

  const isDevMode = !!(
    (app && app.isPackaged === false)
    || (
      process.env.NODE_ENV
      && /^(dev|development)$/i.test(String(process.env.NODE_ENV || ''))
    )
  );

  const uiBridge = createUiBridge({
    getMainWindow: appRuntime.getMainWindow,
    getSideView: appRuntime.getSideView,
    getControlPanelWindow: appRuntime.getControlPanelWindow,
    isDevMode,
  });
  const { sendToSide, getAppConsoleHistory, getDebugConsoleHistory } = uiBridge;

  const sendUpdateUiEvent = sendToSide;
  const appUpdater = createAppUpdater({
    app,
    fs,
    path,
    logger: console,
    getMainWindow: appRuntime.getMainWindow,
    sendToSide: sendUpdateUiEvent,
    appName: APP_DISPLAY_NAME,
    isDevMode,
  });

  const licenseStore = createLicenseStore({
    fs,
    path,
    getStorePath,
    getLatestAllowedPlatforms: appRuntime.getLatestAllowedPlatforms,
    licenseCache,
    logger: console,
  });

  const serverResolver = createServerResolver({
    fs,
    path,
    postJson,
    getServerBase,
    extractValidationState,
    getValidationFailureMessage,
    readStoreConfigSafe: () => licenseStore.readStoreConfigSafe(),
    writeStoreConfigSafe: (store) => licenseStore.writeStoreConfigSafe(store),
    licenseCache,
    setRuntimeTcpConfig,
    setRuntimeServerBase,
    getCurrentPlatformLabel: () => licenseStore.getCurrentPlatformLabel(),
    logger: console,
  });

  const tabHelpers = createTabHelpers({
    logger: console,
    getTabs: () => tabs,
    getMainWindow: appRuntime.getMainWindow,
    getSideView: appRuntime.getSideView,
    getActiveTabId: appRuntime.getActiveTabId,
    getIsSidebarVisible: appRuntime.getIsSidebarVisible,
    setIsSidebarVisible: appRuntime.setIsSidebarVisible,
    sendToSide,
    browserRuntimeManager,
  });

  const runtimeHelpers = createRuntimeHelpers({
    app,
    fs,
    path,
    logger: console,
    getHardwareFingerprint,
  });

  const aiServerCredentialStore = createAiServerDeviceCredentialStore({
    fs,
    path,
    safeStorage,
    filePath: path.join(app.getPath('userData'), 'ai-server-device-credentials.json'),
    logger: console,
  });
  const aiServerDeviceService = createAiServerDeviceService({
    computeDeviceId: runtimeHelpers.computeDeviceId,
    getTools: () => browserAutomationBridge.listExternalMcpTools(),
    callTool: (...args) => browserAutomationBridge.callExternalMcpTool(...args),
    materializeFileRefs: createHeySureFileMaterializer({ sandboxDir: aiSandboxDir }),
    uploadWorkspaceFile: createHeySureFileUploader({ sandboxDir: aiSandboxDir }),
    onStatus: (status) => sendToSide('ai-server-device-status', status),
    credentialStore: aiServerCredentialStore,
    hasVipAccess: () => resolveVipAccess(licenseCache.getSnapshot()).isVip,
    logger: console,
    version: app.getVersion(),
  });

  const extensionManager = createExtensionManager({
    app,
    fs,
    path,
    logger: console,
    getStorePath,
    getTranslateExtDir: runtimeHelpers.getTranslateExtDir,
    getTabs: () => tabs,
    getActiveTabId: appRuntime.getActiveTabId,
    applyPluginSettings,
    sendToSide,
    onPluginStateChanged: async (change) => {
      const tabManager = getTabManager();
      if (!tabManager || typeof tabManager.refreshBrowsersAfterExtensionChange !== 'function') {
        return { ok: true, total: 0, chromiumRestarted: 0 };
      }
      return tabManager.refreshBrowsersAfterExtensionChange(change);
    },
  });

  return {
    APP_DISPLAY_NAME,
    appRuntime,
    tabs,
    browserRuntimeManager,
    systemResourceMonitor,
    browserLaunchGuard,
    backgroundExecutionLeases,
    getBrowserCapacity,
    aiSandboxDir,
    licenseCache,
    browserPartitionCleaner,
    state,
    applyPluginSettings,
    logger,
    browserAutomationBridge,
    aiServerDeviceService,
    isDevMode,
    sendToSide,
    getAppConsoleHistory,
    getDebugConsoleHistory,
    appUpdater,
    licenseStore,
    serverResolver,
    tabHelpers,
    runtimeHelpers,
    extensionManager,
    accountStorage,
    normalizeValidationRuntimeConfig,
    http: { postJson, getJson, httpGetUniversal },
  };
}

module.exports = { createCoreServices };
