// 创建/初始化：createAppState的具体业务逻辑。
function createAppState() {
  const tabs = new Map();

  const state = {
    mainWindow: null,
    licenseWindow: null,
    controlPanelWindow: null,
    activeTabId: null,
    sideView: null,
    consoleWindow: null,
    isSidebarVisible: true,
    isServerShutdownInProgress: false,
    isMainBootstrapped: false,
    isSwitchingToLicense: false,
    latestAllowedPlatforms: [],
    extPopupWin: null,
    globalHttpClient: null,
    pluginSettings: {
      removeWatermarkEnabled: true,
      translateExtEnabled: false,
    },
  };

// 设置/更新/持久化：applyPluginSettings的具体业务逻辑。
  function applyPluginSettings(partial = {}) {
    const hasRemoveWatermark = Object.prototype.hasOwnProperty.call(partial, 'removeWatermarkEnabled');
    const hasTranslateExt = Object.prototype.hasOwnProperty.call(partial, 'translateExtEnabled');
    const nextRemoveWatermarkEnabled = hasRemoveWatermark
      ? partial.removeWatermarkEnabled === true
      : state.pluginSettings.removeWatermarkEnabled === true;
    const nextTranslateExtEnabled = hasTranslateExt
      ? partial.translateExtEnabled === true
      : state.pluginSettings.translateExtEnabled === true;
    state.pluginSettings = {
      removeWatermarkEnabled: nextRemoveWatermarkEnabled,
      translateExtEnabled: nextTranslateExtEnabled,
    };
    return state.pluginSettings;
  }

  return {
    tabs,
    state,
    applyPluginSettings,
    getMainWindow: () => state.mainWindow,
    setMainWindow: (next) => { state.mainWindow = next; },
    getLicenseWindow: () => state.licenseWindow,
    setLicenseWindow: (next) => { state.licenseWindow = next; },
    getControlPanelWindow: () => state.controlPanelWindow,
    setControlPanelWindow: (next) => { state.controlPanelWindow = next; },
    getActiveTabId: () => state.activeTabId,
    setActiveTabId: (next) => { state.activeTabId = next; },
    getSideView: () => state.sideView,
    setSideView: (next) => { state.sideView = next; },
    getConsoleWindow: () => state.consoleWindow,
    setConsoleWindow: (next) => { state.consoleWindow = next; },
    getIsSidebarVisible: () => state.isSidebarVisible,
    setIsSidebarVisible: (next) => { state.isSidebarVisible = next; },
    getIsServerShutdownInProgress: () => state.isServerShutdownInProgress,
    setIsServerShutdownInProgress: (next) => { state.isServerShutdownInProgress = next; },
    getIsMainBootstrapped: () => state.isMainBootstrapped,
    setIsMainBootstrapped: (next) => { state.isMainBootstrapped = next; },
    getIsSwitchingToLicense: () => state.isSwitchingToLicense,
    setIsSwitchingToLicense: (next) => { state.isSwitchingToLicense = next; },
    getLatestAllowedPlatforms: () => state.latestAllowedPlatforms,
    setLatestAllowedPlatforms: (next) => { state.latestAllowedPlatforms = Array.isArray(next) ? next : []; },
    getExtPopupWin: () => state.extPopupWin,
    setExtPopupWin: (next) => { state.extPopupWin = next; },
    getGlobalHttpClient: () => state.globalHttpClient,
    setGlobalHttpClient: (next) => { state.globalHttpClient = next; },
    getPluginSettings: () => state.pluginSettings,
  };
}

module.exports = {
  createAppState,
};
