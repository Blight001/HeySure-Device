'use strict';

function safe(handler) {
  return async (_event, payload = {}) => {
    try { return await handler(payload); } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  };
}

function registerAiSettingsIpc({ ipc, service }) {
  ipc.handle('get-ai-control-settings', safe(() => service.getSettings()));
  ipc.handle('set-ai-control-settings', safe((payload) => service.setSettings(payload)));
  ipc.handle('get-ai-control-custom-api', safe(() => service.getCustomApi()));
  ipc.handle('set-ai-control-custom-api', safe((payload) => service.setCustomApi(payload)));
}

module.exports = { registerAiSettingsIpc };
