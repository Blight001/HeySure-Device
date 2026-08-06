const { BrowserWindow } = require('electron');
const {
  readStoreConfigSafe,
  toFiniteNumber,
  writeStoreConfigSafe,
} = require('./store-utils');
const { createAiSettingsService } = require('../../features/ai-chat/ai-settings-service');
const { registerAiSettingsIpc } = require('../../features/ai-chat/register-settings-ipc');
const { registerBrowserHistoryIpc } = require('../../features/browser/register-browser-history-ipc');
const { registerBrowserSettingsIpc } = require('../../features/browser/register-browser-settings-ipc');
const {
  DEFAULT_BROWSER_WINDOW_NAME,
  DEFAULT_BROWSER_WINDOW_URL,
  buildBrowserHistoryAccountMeta,
  cleanupOrphanBrowserProfiles,
  createBrowserHistoryId,
  makeUniqueBrowserName,
  openBrowserHistoryRecord,
  readBrowserHistorySafe,
  renameBrowserHistoryRecord,
  serializeBrowserHistory,
  syncOpenTabsToBrowserHistory,
  writeBrowserHistorySafe,
} = require('../../features/browser/browser-history-service');

const getBrowserRuntimeInfo = () => ({
  chromiumVersion: String(process.versions?.chrome || ''),
  electronVersion: String(process.versions?.electron || ''),
});


// 获取/读取/解析：getNetworkMagicAutoStartEnabledSafe的具体业务逻辑。
function getNetworkMagicAutoStartEnabledSafe() {
  try {
    const storeConfig = readStoreConfigSafe();
    if (Object.prototype.hasOwnProperty.call(storeConfig || {}, 'networkMagicAutoStartEnabled')) {
      return storeConfig.networkMagicAutoStartEnabled !== false;
    }
  } catch (_) {}
  return true;
}

// 设置/更新/持久化：setNetworkMagicAutoStartEnabledSafe的具体业务逻辑。
function setNetworkMagicAutoStartEnabledSafe(enabled) {
  try {
    const currentStore = readStoreConfigSafe();
    const nextStore = {
      ...(currentStore && typeof currentStore === 'object' ? currentStore : {}),
      networkMagicAutoStartEnabled: enabled === false ? false : true,
    };
    return writeStoreConfigSafe(nextStore);
  } catch (_) {
    return false;
  }
}

function getPluginSettings(ui, extensionManager) {
  const pluginState = ui?.statePluginGetter?.() || {};
  const managedTranslate = typeof extensionManager?.isPluginEnabled === 'function';
  return {
    removeWatermarkEnabled: pluginState.removeWatermarkEnabled === true,
    translateExtEnabled: managedTranslate
      ? extensionManager.isPluginEnabled(extensionManager.BUILTIN_TRANSLATE_ID)
      : pluginState.translateExtEnabled === true,
  };
}

function resolvePluginBoolean(payload, current, key) {
  return Object.prototype.hasOwnProperty.call(payload, key) ? payload[key] === true : current[key] === true;
}

function applyPluginSettingsToRuntime(ui, next) {
  try { ui?.applyPluginSettings?.(next); } catch (error) {
    console.warn('[IPC] 应用插件开关到运行时失败:', error?.message || error);
  }
}

async function updateManagedTranslatePlugin(extensionManager, enabled) {
  if (typeof extensionManager?.setPluginEnabled !== 'function') return;
  try {
    await extensionManager.setPluginEnabled(extensionManager.BUILTIN_TRANSLATE_ID, enabled);
  } catch (error) {
    console.warn('[IPC] 更新翻译插件开关失败:', error?.message || error);
  }
}

async function setPluginSettings(ui, extensionManager, payload) {
  const current = ui?.statePluginGetter?.() || {};
  const hasTranslate = Object.prototype.hasOwnProperty.call(payload, 'translateExtEnabled');
  const next = {
    removeWatermarkEnabled: resolvePluginBoolean(payload, current, 'removeWatermarkEnabled'),
    translateExtEnabled: resolvePluginBoolean(payload, current, 'translateExtEnabled'),
  };
  applyPluginSettingsToRuntime(ui, next);
  if (hasTranslate) await updateManagedTranslatePlugin(extensionManager, next.translateExtEnabled);
  return next;
}

function registerPluginSettingsIpc(ipc, ui, extensionManager) {
  ipc.handle('get-plugin-settings', async () => {
    try { return { ok: true, settings: getPluginSettings(ui, extensionManager) }; } catch (error) {
      console.error('[IPC] 获取插件开关失败:', error);
      return { ok: false, error: error.message, settings: { removeWatermarkEnabled: true, translateExtEnabled: false } };
    }
  });
  ipc.handle('set-plugin-settings', async (_event, payload = {}) => {
    try { return { ok: true, settings: await setPluginSettings(ui, extensionManager, payload || {}) }; } catch (error) {
      console.error('[IPC] 更新插件开关失败:', error);
      return { ok: false, error: error.message };
    }
  });
}

function registerCredentialSettingsIpc(ipc, ctx) {
  const { computeDeviceId, licenseCache } = ctx;
  ipc.handle('get-user-credentials', async () => {
    try {
      const deviceId = typeof computeDeviceId === 'function' ? await computeDeviceId() : '';
      const snapshot = licenseCache?.getSnapshot?.() || { key: '', validated: false };
      return { ok: true, credentials: {
        ...snapshot, deviceId, key: snapshot.key || '', bound: snapshot.bound === true,
        validated: snapshot.validated === true, licenseValidated: snapshot.licenseValidated === true,
      } };
    } catch (error) {
      console.error('[IPC] 获取用户凭证失败:', error);
      return { ok: false, error: error.message };
    }
  });
}

function registerNetworkSettingsIpc(ipc, licenseCache) {
  ipc.handle('update-system-proxy-enabled', async (_event, { enabled }) => {
    try {
      licenseCache?.setRuntimeConfig?.({ systemProxyEnabled: enabled });
      console.log('[IPC] 系统代理状态已更新:', enabled, '模式:', 'clash');
      return { ok: true, enabled, mode: 'clash' };
    } catch (error) {
      console.error('[IPC] 更新系统代理状态失败:', error);
      return { ok: false, error: error.message };
    }
  });
  ipc.handle('get-network-magic-auto-start-enabled', async () => ({
    ok: true, enabled: getNetworkMagicAutoStartEnabledSafe(),
  }));
  ipc.handle('set-network-magic-auto-start-enabled', async (_event, payload = {}) => {
    const enabled = payload.enabled !== false;
    try {
      const wrote = setNetworkMagicAutoStartEnabledSafe(enabled);
      return wrote ? { ok: true, enabled } : { ok: false, error: '保存网络魔法自动开启状态失败', enabled };
    } catch (error) {
      console.error('[IPC] 更新网络魔法自动开启状态失败:', error);
      return { ok: false, error: error.message, enabled };
    }
  });
}

async function readVpnStatusFromWindows() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const result = await win.webContents.executeJavaScript(`new Promise((resolve) => {
      if (typeof window !== 'undefined' && window.sidePanelVPNStatus !== undefined) resolve({ ok: true, enabled: window.sidePanelVPNStatus });
      else if (typeof isVpnEnabled !== 'undefined') resolve({ ok: true, enabled: isVpnEnabled });
      else { const btn = document.getElementById('VPN-switch'); resolve({ ok: true, enabled: btn?.textContent ? btn.textContent.includes('关闭') : true }); }
    })`);
    if (result?.ok) return result;
  }
  return { ok: true, enabled: true };
}

function registerVpnAndForwardingIpc(ipc, ui) {
  ipc.handle('get-vpn-status', async () => {
    try {
      const result = await readVpnStatusFromWindows();
      console.log('[IPC] 获取到渲染进程 VPN 状态:', result.enabled);
      return result;
    } catch (error) {
      console.error('[IPC] 获取 VPN 状态失败:', error);
      return { ok: true, enabled: true };
    }
  });
  ipc.on('server-account-cookie-received', (_event, data) => {
    try {
      if (!ui?.sendToSide) throw new Error('ui.sendToSide不可用，无法转发账号cookie消息');
      ui.sendToSide('server-account-cookie-received', data);
    } catch (error) {
      console.error('[IPC] 转发账号cookie消息失败:', error);
    }
  });
}

// 监听/绑定：registerSettingsIPC的具体业务逻辑。
function registerSettingsIPC(ctx) {
  const ipc = ctx.ipc.scope('register/settings');
  const { ui, computeDeviceId, licenseCache } = ctx;
  const extensionManager = ctx.extensionManager || ui?.extensionManager || null;
  registerBrowserHistoryIpc({ ipc, ui, licenseCache });
  registerBrowserSettingsIpc({ ipc, ui, licenseCache });

  const aiSettingsService = createAiSettingsService({
    readStore: readStoreConfigSafe,
    writeStore: writeStoreConfigSafe,
    licenseCache,
  });
  registerAiSettingsIpc({ ipc, service: aiSettingsService });
  registerPluginSettingsIpc(ipc, ui, extensionManager);
  registerCredentialSettingsIpc(ipc, { computeDeviceId, licenseCache });
  registerNetworkSettingsIpc(ipc, licenseCache);
  registerVpnAndForwardingIpc(ipc, ui);
}

module.exports = {
  DEFAULT_BROWSER_WINDOW_NAME,
  DEFAULT_BROWSER_WINDOW_URL,
  buildBrowserHistoryAccountMeta,
  cleanupOrphanBrowserProfiles,
  createBrowserHistoryId,
  makeUniqueBrowserName,
  openBrowserHistoryRecord,
  readBrowserHistorySafe,
  registerSettingsIPC,
  renameBrowserHistoryRecord,
  serializeBrowserHistory,
  syncOpenTabsToBrowserHistory,
  writeBrowserHistorySafe,
};
