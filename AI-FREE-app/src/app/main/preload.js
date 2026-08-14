// preload：只向页面暴露按业务域拆分的具名能力。
// 每个方法固定绑定单一 IPC 通道，页面无法提交任意 channel。
const { contextBridge, ipcRenderer } = require('electron');

// 页面脚本异常不会自动到达主进程。这里直接走只写日志的内部通道，
// 不向页面暴露任何额外权限，也不依赖业务 IPC 完成初始化。
window.addEventListener('error', (event) => {
  try {
    ipcRenderer.send('__ai_free_renderer_error__', {
      message: event.message || event.error?.message || 'renderer error',
      stack: event.error?.stack || '',
      source: event.filename || '',
      line: event.lineno || 0,
      column: event.colno || 0,
    });
  } catch (_) {}
});

window.addEventListener('unhandledrejection', (event) => {
  try {
    const reason = event.reason;
    ipcRenderer.send('__ai_free_renderer_error__', {
      message: reason?.message || String(reason || 'unhandled renderer rejection'),
      stack: reason?.stack || '',
      source: 'unhandledrejection',
    });
  } catch (_) {}
});

const invokeChannel = (channel) => (data) => ipcRenderer.invoke(channel, data);
const sendChannel = (channel) => (data) => ipcRenderer.send(channel, data);
const subscribeChannel = (channel) => (listener) => {
  if (typeof listener !== 'function') throw new TypeError(`${channel} listener 必须是函数`);
  const wrapped = (_event, ...args) => listener(...args);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

// renderer API：每个方法固定绑定单一通道，调用方无法传入任意 channel。
contextBridge.exposeInMainWorld('aiFree', Object.freeze({
  ai: Object.freeze({
    chat: invokeChannel('ai-control-chat'),
    chatInsert: invokeChannel('ai-control-chat-insert'),
    chatStop: invokeChannel('ai-control-chat-stop'),
    getAutomationCards: invokeChannel('ai-control-get-automation-cards'),
    getBrowserConnections: invokeChannel('ai-control-get-browser-connections'),
    getModels: invokeChannel('ai-control-get-models'),
    getPromptDiagnostics: invokeChannel('ai-control-get-prompt-diagnostics'),
    manageAutomationCard: invokeChannel('ai-control-manage-automation-card'),
    historyDelete: invokeChannel('ai-control-history-delete'),
    historyGet: invokeChannel('ai-control-history-get'),
    historyList: invokeChannel('ai-control-history-list'),
    historyRename: invokeChannel('ai-control-history-rename'),
    historySave: invokeChannel('ai-control-history-save'),
    redeemGiftCode: invokeChannel('ai-control-redeem-gift-code'),
    saveAutomationSession: invokeChannel('ai-control-save-automation-session'),
    selectAutomationCard: invokeChannel('ai-control-select-automation-card'),
    getCustomApi: invokeChannel('get-ai-control-custom-api'),
    getServerDeviceStatus: invokeChannel('get-ai-server-device-status'),
    getSettings: invokeChannel('get-ai-control-settings'),
    loginServerDevice: invokeChannel('login-ai-server-device'),
    logoutServerDevice: invokeChannel('logout-ai-server-device'),
    setCustomApi: invokeChannel('set-ai-control-custom-api'),
    setSettings: invokeChannel('set-ai-control-settings'),
    emitBrowserSelectionChanged: sendChannel('ai-control-browser-selection-changed'),
    onBrowserSelectionChanged: subscribeChannel('ai-control-browser-selection-changed'),
    onServerDeviceStatus: subscribeChannel('ai-server-device-status'),
    onChatEvent: subscribeChannel('ai-control-chat-event'),
  }),
  account: Object.freeze({
    authenticate: invokeChannel('account-authenticate'),
    getSession: invokeChannel('account-get-session'),
    logout: invokeChannel('account-logout'),
    onServerAccountCookieReceived: subscribeChannel('server-account-cookie-received'),
    onSessionUpdated: subscribeChannel('account-session-updated'),
  }),
  license: Object.freeze({
    getDeviceId: invokeChannel('license-get-device-id'),
    getUserCredentials: invokeChannel('get-user-credentials'),
    getVipPlans: invokeChannel('get-vip-plans'),
    redeemVipGiftCode: invokeChannel('redeem-vip-gift-code'),
    redeemWoolGiftCode: invokeChannel('redeem-wool-gift-code'),
    unbindDevice: invokeChannel('unbind-device'),
    onCredentialsUpdated: subscribeChannel('license-credentials-updated'),
    onOpenVipPlans: subscribeChannel('open-vip-plans'),
    onVipAccessRequired: subscribeChannel('vip-access-required'),
  }),
  network: Object.freeze({
    getAutoStartEnabled: invokeChannel('get-network-magic-auto-start-enabled'),
    getClashConfig: invokeChannel('get-clash-config'),
    getClashProxyOptions: invokeChannel('get-clash-mini-proxy-options'),
    getClashStatus: invokeChannel('get-clash-mini-status'),
    getProxyTrafficQuota: invokeChannel('get-proxy-traffic-quota'),
    redeemProxyTrafficGiftCode: invokeChannel('redeem-proxy-traffic-gift-code'),
    saveClashConfig: invokeChannel('save-clash-config'),
    setAutoStartEnabled: invokeChannel('set-network-magic-auto-start-enabled'),
    startClash: invokeChannel('start-clash-mini'),
    stopClash: invokeChannel('stop-clash-mini'),
    switchClashProxy: invokeChannel('switch-clash-mini-proxy'),
    testMinLatency: invokeChannel('test-min-latency'),
    onAppShuttingDown: subscribeChannel('app-shutting-down'),
    onClashLatencyProgress: subscribeChannel('clash-mini-latency-progress'),
    onClashRuntimeFailed: subscribeChannel('clash-mini-runtime-failed'),
    onClashStatus: subscribeChannel('clash-mini-status'),
    onProxyTrafficExhausted: subscribeChannel('proxy-traffic-exhausted'),
    onProxyTrafficQuota: subscribeChannel('proxy-traffic-quota'),
  }),
  browser: Object.freeze({
    deleteHistory: invokeChannel('delete-browser-history'),
    extractProxy: invokeChannel('extract-ai-free-proxy'),
    getHistory: invokeChannel('get-browser-history'),
    getSettings: invokeChannel('get-ai-free-browser-settings'),
    openHistory: invokeChannel('open-browser-history'),
    renameHistory: invokeChannel('rename-browser-history'),
    renameHistoryBatch: invokeChannel('rename-browser-history-batch'),
    resetSettings: invokeChannel('reset-ai-free-browser-settings'),
    resolveDataClearConfirm: invokeChannel('resolve-browser-data-clear-confirm'),
    setSettings: invokeChannel('set-ai-free-browser-settings'),
    testProxy: invokeChannel('test-ai-free-proxy'),
    onAccountListUpdated: subscribeChannel('account-list-updated'),
    onDataClearConfirmRequested: subscribeChannel('browser-data-clear-confirm-request'),
    onHistoryChanged: subscribeChannel('browser-history-changed'),
    onHistoryGestureSelection: subscribeChannel('browser-history-gesture-selection'),
    onTabsUpdated: subscribeChannel('update-tabs'),
  }),
  content: Object.freeze({
    getPlatformName: invokeChannel('get-platform-name'),
    getTargetUrl: invokeChannel('get-target-url'),
    getTutorialUrl: invokeChannel('get-tutorial-url'),
    getWoolPlatforms: invokeChannel('get-wool-platforms'),
    openDreamPage: invokeChannel('open-dream-page'),
    refreshTutorialUrl: invokeChannel('refresh-tutorial-url'),
    refreshWoolPlatforms: invokeChannel('refresh-wool-platforms'),
    openTutorial: sendChannel('open-tutorial'),
    onPlatformNameUpdated: subscribeChannel('platform-name-updated'),
    onTargetUrlUpdated: subscribeChannel('target-url-updated'),
    onTutorialUrlUpdated: subscribeChannel('tutorial-url-updated'),
    onWoolPlatformsUpdated: subscribeChannel('wool-platforms-updated'),
  }),
  extensions: Object.freeze({
    getState: invokeChannel('get-extension-manager-state'),
    importPlugin: invokeChannel('import-extension-plugin'),
    removePlugin: invokeChannel('remove-extension-plugin'),
    setEnabled: invokeChannel('set-extension-enabled'),
    onStateChanged: subscribeChannel('extension-manager-state'),
  }),
  updates: Object.freeze({
    getAppVersion: invokeChannel('get-app-version'),
    start: invokeChannel('start-app-update'),
    onActivated: subscribeChannel('app-update-activated'),
    onComplete: subscribeChannel('app-update-complete'),
    onError: subscribeChannel('app-update-error'),
    onNotice: subscribeChannel('app-update-notice'),
    onProgress: subscribeChannel('app-update-progress'),
    onSkip: subscribeChannel('app-update-skip'),
  }),
  shell: Object.freeze({
    clearBrowserRuntimeData: invokeChannel('clear-browser-runtime-data'),
    createIndependentBrowser: invokeChannel('create-independent-browser'),
    openActiveWebConsole: invokeChannel('open-active-web-console'),
    restartBrowserRuntime: invokeChannel('restart-browser-runtime'),
    openBrowserDiagnostics: invokeChannel('open-browser-diagnostics'),
    showBrowserHistoryGesturePopup: invokeChannel('show-browser-history-gesture-popup'),
    showTabContextMenu: invokeChannel('show-tab-context-menu'),
    closeBrowserHistoryGesturePopup: sendChannel('close-browser-history-gesture-popup'),
    closeTab: sendChannel('close-tab'),
    reorderTab: sendChannel('reorder-tab'),
    switchTab: sendChannel('switch-tab'),
    toggleSidebar: sendChannel('toggle-sidebar'),
    updateBrowserHistoryGestureSelection: sendChannel('update-browser-history-gesture-popup-selection'),
    onIndependentBrowserCreateComplete: subscribeChannel('independent-browser-create-complete'),
    onIndependentBrowserCreateFailed: subscribeChannel('independent-browser-create-failed'),
  }),
  ui: Object.freeze({
    emitAppThemeChanged: sendChannel('app-theme-changed'),
    emitServerAccountCookieReceived: sendChannel('server-account-cookie-received'),
    focusSidebarInput: invokeChannel('focus-sidebar-input'),
    requestAccountCenter: sendChannel('request-account-center'),
    setSidebarWidth: invokeChannel('set-sidebar-width'),
    getWindowCloseBehavior: invokeChannel('get-window-close-behavior'),
    setWindowCloseBehavior: invokeChannel('set-window-close-behavior'),
    setZoom: sendChannel('set-zoom'),
    onAppThemeChanged: subscribeChannel('app-theme-changed'),
    onAppVersion: subscribeChannel('app-version'),
    onDeviceIdUpdated: subscribeChannel('update-device-id'),
    onLicenseUsageUpdated: subscribeChannel('license-usage-updated'),
    onOpenAccountCenter: subscribeChannel('open-account-center'),
    onServerAnnouncementsReset: subscribeChannel('server-announcements-reset'),
    onServerMessage: subscribeChannel('server-message'),
    onSidebarCollapse: subscribeChannel('sidebar-collapse'),
    onSidebarExpand: subscribeChannel('sidebar-expand'),
  }),
  diagnostics: Object.freeze({
    getConsoleHistory: invokeChannel('get-app-console-history'),
    onConsoleLine: subscribeChannel('app-console-line'),
  }),
}));

contextBridge.exposeInMainWorld('env', {
  NODE_ENV: process.env.NODE_ENV || ''
});

// --- 监听缩放更新事件并转发到页面上下文 ---
ipcRenderer.on('active-zoom', (event, zoomFactor) => {
  // 通过 postMessage 发送到页面上下文
  window.postMessage({ type: 'active-zoom', zoomFactor }, '*');
});
