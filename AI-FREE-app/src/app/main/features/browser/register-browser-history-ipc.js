'use strict';

const { normalizeAiFreeBrowserSettings } = require('../../utils/ai-free-browser-settings');
const { FREE_BROWSER_WINDOW_LIMIT, createVipRequiredResult, resolveVipAccess } = require('../../utils/vip-access');
const { readStoreConfigSafe } = require('../../ipc/register/store-utils');
const historyService = require('./browser-history-service');
const { createBrowserHistoryPopupController } = require('./browser-history-popup-controller');
const { createBrowserHistoryIpcHandlers } = require('./browser-history-ipc-handlers');

function registerBrowserHistoryIpc({ ipc, ui, licenseCache }) {
  const popup = createBrowserHistoryPopupController({ ui });
  const handlers = createBrowserHistoryIpcHandlers({
    ...historyService,
    FREE_BROWSER_WINDOW_LIMIT,
    createVipRequiredResult,
    licenseCache,
    normalizeAiFreeBrowserSettings,
    popup,
    readStoreConfigSafe,
    resolveVipAccess,
    ui,
  });
  handlers.cleanupStartupProfiles();
  ipc.handle('get-browser-history', handlers.getBrowserHistory);
  ipc.handle('show-browser-history-gesture-popup', handlers.showGesturePopup);
  ipc.on('update-browser-history-gesture-popup-selection', handlers.updateGesturePopup);
  ipc.on('close-browser-history-gesture-popup', handlers.closeGesturePopup);
  ipc.handle('cleanup-orphan-browser-profiles', handlers.cleanupOrphanProfiles);
  ipc.handle('create-independent-browser', handlers.createIndependentBrowser);
  ipc.handle('open-browser-history', handlers.openBrowserHistory);
  ipc.handle('rename-browser-history', handlers.renameBrowserHistory);
  ipc.handle('rename-browser-history-batch', handlers.renameBrowserHistoryBatch);
  ipc.handle('delete-browser-history', handlers.deleteBrowserHistory);
}

module.exports = { registerBrowserHistoryIpc };
