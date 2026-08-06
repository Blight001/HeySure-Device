const { BrowserWindow, dialog } = require('electron');
const { createVipRequiredResult, resolveVipAccess } = require('../../utils/vip-access');

function registerExtensionsIPC(ctx = {}) {
  const ipc = ctx.ipc.scope('register/extensions');
  const extensionManager = ctx.extensionManager || ctx.ui?.extensionManager || null;
  const hasVipAccess = () => resolveVipAccess(ctx.licenseCache?.getSnapshot?.() || {}).isVip;

  function ensureManager() {
    if (!extensionManager) {
      return { ok: false, message: '插件管理器不可用', state: { developerModeEnabled: false, plugins: [] } };
    }
    return null;
  }

  ipc.handle('get-extension-manager-state', async () => {
    const missing = ensureManager();
    if (missing) return missing;
    return { ok: true, vipRequired: !hasVipAccess(), state: extensionManager.getPublicState() };
  });

  ipc.handle('set-extension-enabled', async (_event, payload = {}) => {
    const missing = ensureManager();
    if (missing) return missing;
    try {
      return await extensionManager.setPluginEnabled(payload?.id, payload?.enabled === true);
    } catch (error) {
      return { ok: false, message: error?.message || String(error), state: extensionManager.getPublicState() };
    }
  });

  ipc.handle('remove-extension-plugin', async (_event, payload = {}) => {
    const missing = ensureManager();
    if (missing) return missing;
    try {
      return await extensionManager.removePlugin(payload?.id);
    } catch (error) {
      return { ok: false, message: error?.message || String(error), state: extensionManager.getPublicState() };
    }
  });

  ipc.handle('import-extension-plugin', async (_event) => {
    const missing = ensureManager();
    if (missing) return missing;
    if (!hasVipAccess()) {
      return { ...createVipRequiredResult('导入自定义插件'), state: extensionManager.getPublicState() };
    }
    try {
      const owner = BrowserWindow.fromWebContents(_event.sender) || undefined;
      const selection = owner
        ? await dialog.showOpenDialog(owner, {
          title: '选择解压后的浏览器插件目录',
          properties: ['openDirectory'],
        })
        : await dialog.showOpenDialog({
          title: '选择解压后的浏览器插件目录',
          properties: ['openDirectory'],
        });
      if (selection.canceled || !selection.filePaths?.[0]) {
        return { ok: false, canceled: true, state: extensionManager.getPublicState() };
      }
      return await extensionManager.importPlugin(selection.filePaths[0]);
    } catch (error) {
      return { ok: false, message: error?.message || String(error), state: extensionManager.getPublicState() };
    }
  });

}

module.exports = { registerExtensionsIPC };
