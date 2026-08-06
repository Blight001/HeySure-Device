'use strict';

function safe(handler) {
  return async (_event, payload = {}) => {
    try { return await handler(payload); } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  };
}

function registerAiServerDeviceIpc({ ipc, service }) {
  ipc.handle('get-ai-server-device-status', safe(() => ({ ok: true, status: service.status() })));
  ipc.handle('login-ai-server-device', safe((payload) => service.login(payload)));
  ipc.handle('logout-ai-server-device', safe(() => service.logout()));
}

module.exports = { registerAiServerDeviceIpc };
