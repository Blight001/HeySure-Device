'use strict';

function registerAiSupportIpc({ ipc, service }) {
  ipc.handle('ai-control-get-models', async () => {
    try {
      return await service.getModels();
    } catch (error) {
      return { ok: false, message: error?.message || String(error) };
    }
  });

  ipc.handle('ai-control-get-browser-connections', async () => {
    try {
      return service.getBrowserConnections();
    } catch (error) {
      return { ok: false, message: error?.message || String(error), connections: [] };
    }
  });

  ipc.handle('ai-control-redeem-gift-code', async (_event, input = {}) => {
    try {
      return await service.redeemGiftCode(input);
    } catch (error) {
      return { ok: false, message: error?.message || String(error) };
    }
  });

  ipc.handle('ai-control-get-automation-cards', async () => {
    try {
      return await service.getAutomationCards();
    } catch (error) {
      return { ok: false, message: error?.message || String(error), cards: [], selectedId: '' };
    }
  });

  ipc.handle('ai-control-manage-automation-card', async (_event, input = {}) => {
    try {
      return await service.manageAutomationCard(input);
    } catch (error) {
      return { ok: false, message: error?.message || String(error) };
    }
  });

  ipc.handle('ai-control-save-automation-session', async (_event, input = {}) => {
    try {
      return await service.saveAutomationSession(input);
    } catch (error) {
      return { ok: false, message: error?.message || String(error) };
    }
  });

  ipc.on('ai-control-browser-selection-changed', (_event, input = {}) => {
    service.broadcastBrowserSelection(input);
  });

  ipc.handle('ai-control-select-automation-card', async (_event, input = {}) => {
    try {
      return service.selectAutomationCard(input);
    } catch (error) {
      return { ok: false, message: error?.message || String(error) };
    }
  });
}

module.exports = { registerAiSupportIpc };
