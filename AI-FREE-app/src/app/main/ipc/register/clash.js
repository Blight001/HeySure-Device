const { createClashIpcHandlers } = require('../../features/network/clash-ipc-handlers');

function registerClashIPC(ctx) {
  const ipc = ctx.ipc.scope('register/clash');
  const handlers = createClashIpcHandlers(ctx);
  ipc.handle('start-clash-mini', handlers['start-clash-mini']);
  ipc.handle('test-min-latency', handlers['test-min-latency']);
  ipc.handle('get-clash-mini-proxy-options', handlers['get-clash-mini-proxy-options']);
  ipc.handle('switch-clash-mini-proxy', handlers['switch-clash-mini-proxy']);
  ipc.handle('get-clash-mini-status', handlers['get-clash-mini-status']);
  ipc.handle('stop-clash-mini', handlers['stop-clash-mini']);
  ipc.handle('get-proxy-traffic-quota', handlers['get-proxy-traffic-quota']);
  ipc.handle('redeem-proxy-traffic-gift-code', handlers['redeem-proxy-traffic-gift-code']);
  ipc.handle('ensure-clash-config-dir', handlers['ensure-clash-config-dir']);
  ipc.handle('get-clash-config', handlers['get-clash-config']);
  ipc.handle('stop-clash-service', handlers['stop-clash-service']);
  ipc.handle('save-clash-config', handlers['save-clash-config']);
}

module.exports = { registerClashIPC };
