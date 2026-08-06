const { ipcMain } = require('electron');
const { createIpcRegistry } = require('./registry');
const { createStructuredLogger } = require('../lib/structured-log');

const slog = createStructuredLogger(console, { domain: 'ipc' });
const { registerAccountIPC } = require('./account_remember');
const { registerClashIPC } = require('./register/clash');
const { registerLicenseIPC } = require('./register/license');
const { registerMiscIPC } = require('./register/misc');
const { registerSettingsIPC } = require('./register/settings');
const { registerUiIPC } = require('./register/ui');
const { registerExtensionsIPC } = require('./register/extensions');

// 上一轮 registerIPC 创建的注册器。重登录/重引导会整体重跑 registerIPC，
// 此时先显式释放旧注册，替代原先 monkeypatch ipcMain 的静默去重补丁；
// 同一轮内的重复注册是真实冲突，由 registry 立即抛错并指出双方来源。
let activeRegistry = null;

// 监听/绑定：registerIPC的具体业务逻辑。
function registerIPC(ctx) {
  if (activeRegistry) {
    slog.warn('reregister', { operationDetail: '重跑 registerIPC，先释放旧注册', ...activeRegistry.stats() });
    activeRegistry.dispose();
  }
  activeRegistry = createIpcRegistry(ipcMain, { source: 'registerIPC' });
  ctx.ipc = activeRegistry;

  registerLicenseIPC(ctx);
  registerUiIPC(ctx);
  registerExtensionsIPC(ctx);
  registerMiscIPC(ctx);
  registerSettingsIPC(ctx);
  registerClashIPC(ctx);
  registerAccountIPC(ctx);

  return activeRegistry;
}

module.exports = { registerIPC };
