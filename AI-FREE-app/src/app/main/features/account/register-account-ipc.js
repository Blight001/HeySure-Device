'use strict';

function registerAccountIpc({ ipc, service }) {
  ipc.handle('account-get-session', async () => {
    try {
      return service.getSession();
    } catch (error) {
      return { ok: false, message: error?.message || String(error) };
    }
  });
  ipc.handle('account-authenticate', async (_event, input = {}) => {
    try {
      return await service.authenticate(input);
    } catch (error) {
      return { ok: false, message: error?.message || String(error) };
    }
  });
  ipc.handle('account-logout', async () => {
    try {
      return await service.logout();
    } catch (error) {
      return { ok: false, message: error?.message || String(error) };
    }
  });
}

module.exports = { registerAccountIpc };
