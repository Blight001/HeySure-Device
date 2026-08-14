// 主进程 composition root（阶段 2D-3 收缩后）：
// 只负责创建依赖、装配服务与生命周期注册；具体装配细节在 composition/ 下：
//   electron-runtime-tuning  —— ready 前的 GPU/节流/防挂起调优
//   create-core-services     —— appRuntime/浏览器运行时/更新器等服务创建
//   create-refresh-platforms —— 平台/目标地址/教程地址运行时刷新
//   build-app-shell-deps     —— createAppShell 依赖装配
//   build-lifecycle-deps     —— registerAppLifecycle 依赖装配
const { app, BrowserWindow, WebContentsView, dialog, Menu, Tray, powerSaveBlocker, safeStorage, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { acquireSingleInstance, applyWindowsAppUserModelId } = require('./composition/startup-guards');
const { tuneElectronRuntime } = require('./composition/electron-runtime-tuning');
const { createCoreServices } = require('./composition/create-core-services');
const { createRefreshAllowedPlatformsAndNotify } = require('./composition/create-refresh-platforms');
const { buildAppShellDeps } = require('./composition/build-app-shell-deps');
const { buildLifecycleDeps } = require('./composition/build-lifecycle-deps');
const { createAppShell } = require('./services/app-shell');
const { createTabManager } = require('./services/tab-manager');
const { registerAppLifecycle } = require('./services/app-lifecycle');
const { setDreamTargetUrl, getStorePath } = require('./config');
const { resolveTabBrowserProfile } = require('./utils/browser-profile');
const { httpGetUniversal } = require('./lib/http');
const { createCrashLoopGuard } = require('./runtime/crash-loop-guard');

// 启动/打开/显示：startMainApp的具体业务逻辑。
function startMainApp() {
  applyWindowsAppUserModelId();
  const crashLoopDecision = createCrashLoopGuard({
    filePath: path.join(app.getPath('userData'), 'crash-reports', 'crash-loop.json'),
  }).inspect();
  if (crashLoopDecision.safeMode) app.disableHardwareAcceleration();
  tuneElectronRuntime({ app, fs, getStorePath });

  // ---- 单例应用 ----
  const isPrimaryInstance = acquireSingleInstance({
    onSecondInstance: () => {
      if (appShell?.revealMainWindow?.()) return;
      const targetWin = services.appRuntime.getMainWindow() || services.appRuntime.getLicenseWindow();
      if (targetWin) {
        if (targetWin.isMinimized()) targetWin.restore();
        targetWin.show?.();
        targetWin.focus();
      }
    },
  });
  if (!isPrimaryInstance) return;

  // ---- 核心服务 ----
  let tabManager;
  const services = createCoreServices({
    app, fs, path, BrowserWindow, powerSaveBlocker, safeStorage,
    safeModePolicy: crashLoopDecision.safeModePolicy,
    getTabManager: () => tabManager,
  });
  const { appRuntime, tabs, sendToSide, licenseCache } = services;
  if (crashLoopDecision.safeMode) {
    app.whenReady().then(() => dialog.showMessageBox({
      type: 'warning',
      title: 'AI-FREE 安全模式',
      message: '检测到主程序短时间内连续异常退出，已进入安全模式。',
      detail: '本次不会执行 Chromium 后台预热，并已关闭硬件加速。请先关闭不必要的软件，再手动打开浏览器环境。',
    })).catch(() => {});
  }

  // ---- 晚绑定（tabManager/auth/appShell 创建后回填）----
  let auth;
  let addTab;
  let openTutorialTab;
  let syncTutorialTabUrl;
  let applyClashMiniBrowserProxy;
  let switchTab;
  let closeTab;
  let reorderTab;
  let renameTab;
  let setTabAccountId;
  let setTabBrowserSettings;
  let setZoom;
  let refreshActiveTabToUrl;
  let refreshActiveTab;
  let refreshTab;
  let appShell = null;

  const late = {
    getAuth: () => auth,
    setAuth: (next) => { auth = next; },
    getAddTab: () => addTab,
    getOpenTutorialTab: () => openTutorialTab,
    getSyncTutorialTabUrl: () => syncTutorialTabUrl,
    getSwitchTab: () => switchTab,
    getCloseTab: () => closeTab,
    getReorderTab: () => reorderTab,
    getRenameTab: () => renameTab,
    getSetTabBrowserSettings: () => setTabBrowserSettings,
    getSetZoom: () => setZoom,
    getRefreshActiveTabToUrl: () => refreshActiveTabToUrl,
    getRefreshActiveTab: () => refreshActiveTab,
    getRefreshTab: () => refreshTab,
  };

  // 每个会话(session) -> 扩展ID 映射，用于后续打开 popup/options
  const extIdBySession = new WeakMap();

  // 停止/关闭/清理：resetRuntimeTutorialUrlState的具体业务逻辑。
  function resetRuntimeTutorialUrlState() {
    // 教程只在应用启动阶段自动打开一次；登录后的配置刷新不重置该行为。
  }

  const refreshAllowedPlatformsAndNotify = createRefreshAllowedPlatformsAndNotify({
    licenseCache,
    appRuntime,
    sendToSide,
    setDreamTargetUrl,
    getSyncTutorialTabUrl: late.getSyncTutorialTabUrl,
    updateLicenseRecordPlatform: services.licenseStore.updateLicenseRecordPlatform,
    normalizeValidationRuntimeConfig: services.normalizeValidationRuntimeConfig,
  });

  // ---- 应用外壳 ----
  const appShellDeps = buildAppShellDeps({
    electron: { app, fs, path, BrowserWindow, WebContentsView, dialog, Menu, Tray, screen },
    services,
    refreshAllowedPlatformsAndNotify,
    resetRuntimeTutorialUrlState,
    extIdBySession,
    late,
    getAppShell: () => appShell,
  });
  // appShell 会在构造时复制依赖，而 tabManager 要到下一步才创建。使用稳定包装器
  // 晚绑定真实动作，避免后续写回原 deps 对象却无法进入 IPC 的 ui context。
  appShellDeps.applyClashMiniBrowserProxy = (...args) => (
    typeof applyClashMiniBrowserProxy === 'function'
      ? applyClashMiniBrowserProxy(...args)
      : null
  );
  appShell = createAppShell(appShellDeps);

  // ---- 标签管理 ----
  tabManager = createTabManager({
    browserLaunchGuard: services.browserLaunchGuard,
    browserRuntimeManager: services.browserRuntimeManager,
    fs,
    logger: console,
    extensionManager: services.extensionManager,
    cleanupBrowserSessionData: services.browserPartitionCleaner.cleanupBrowserSessionData,
    getStorePath,
    getTabs: () => tabs,
    getMainWindow: appRuntime.getMainWindow,
    setMainWindow: appRuntime.setMainWindow,
    getSideView: appRuntime.getSideView,
    setSideView: appRuntime.setSideView,
    getActiveTabId: appRuntime.getActiveTabId,
    setActiveTabId: appRuntime.setActiveTabId,
    getIsSidebarVisible: appRuntime.getIsSidebarVisible,
    setIsSidebarVisible: appRuntime.setIsSidebarVisible,
    getSetTabAccountId: () => setTabAccountId,
    getAuth: late.getAuth,
    licenseCache,
    resolveAdministratorBrowserLimit: () => (
      services.licenseCache.getRuntimeConfig?.().browserCapacityLimit
    ),
    sendToSide,
    updateTabs: services.tabHelpers.updateTabs,
    httpGetUniversal,
    resolveTabBrowserProfile,
    extIdBySession,
  });

  ({
    addTab,
    openTutorialTab,
    syncTutorialTabUrl,
    applyClashMiniBrowserProxy,
    switchTab,
    closeTab,
    reorderTab,
    renameTab,
    setTabAccountId,
    setTabBrowserSettings,
    setZoom,
    refreshActiveTabToUrl,
    refreshActiveTab,
    refreshTab,
  } = tabManager);

  // ---- 生命周期 ----
  const lifecycleRegistration = registerAppLifecycle(buildLifecycleDeps({
    app,
    fs,
    services,
    appShell,
    refreshAllowedPlatformsAndNotify,
    late,
  }));
  app.once('will-quit', () => lifecycleRegistration.dispose());
}

module.exports = {
  startMainApp,
};
