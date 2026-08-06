const {
  createIpcRegistry,
} = require('../ipc/registry');
const {
  BROWSER_CONNECTION_START_MATCH_WINDOW_MS,
  enrichBrowserConnectionNames,
} = require('../features/ai-chat/connection-names');
const { registerAppShutdown } = require('../platform/app-shutdown');
const { bootstrapReadyApp } = require('./app-ready-bootstrap');

// 监听/绑定：registerAppLifecycle的具体业务逻辑。
function registerAppLifecycle(deps = {}) {
  const {
    app,
    ipcMain,
    sendToSide,
    cleanupAllBrowserSessionData,
    cleanupBrowserPartitionsRootDir,
    cleanupUpdateStorageRoot,
    shortcutManager,
    getGlobalHttpClient,
    BrowserWindow,
    createMainWindow,
    revealMainWindow,
    getMainWindow,
    logger = console,
  } = deps;
  const ipcRegistry = createIpcRegistry(ipcMain, { source: 'app-lifecycle' });
  const ipc = ipcRegistry.scope('services/app-lifecycle');
  const {
    cleanupClashMiniRuntimeConfig,
    getClashMiniRuntimeRoot,
    stopClashMiniProcess,
  } = require('../ipc/register/clash-mini-core');

  app.whenReady().then(() => bootstrapReadyApp({
    ...deps,
    logger,
    stopClashMiniProcess,
  }, ipc));

  registerAppShutdown({
    ...deps,
    app,
    BrowserWindow,
    cleanupAllBrowserSessionData,
    cleanupBrowserPartitionsRootDir,
    cleanupClashMiniRuntimeConfig,
    getClashMiniRuntimeRoot,
    getGlobalHttpClient,
    logger,
    sendToSide,
    shortcutManager,
    stopClashMiniProcess,
  });

  app.on('window-all-closed', async () => {
    if (typeof deps.isSwitchingToLicense === 'function' && deps.isSwitchingToLicense()) return;
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    const mainWindow = getMainWindow?.();
    if (mainWindow && !mainWindow.isDestroyed?.()) {
      revealMainWindow?.();
      return;
    }
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });

  return ipcRegistry;
}

module.exports = {
  BROWSER_CONNECTION_START_MATCH_WINDOW_MS,
  enrichBrowserConnectionNames,
  registerAppLifecycle,
};
