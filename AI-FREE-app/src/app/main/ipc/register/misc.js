const { app } = require('electron');
const { appContext } = require('../../runtime/app-context');
const { createHttpClient } = require('../../lib/http-client');
const { getStorePath } = require('../../config');
const { summarizeUpdatePayload } = require('../../utils/update-payload');

const DEFAULT_TUTORIAL_URL = 'https://www.yuque.com/kelingaishipindian/tx5gwq/xbsl692ls9xope0e?singleDoc#';

// 监听/绑定：registerMiscIPC的具体业务逻辑。
function registerMiscIPC(ctx) {
  const ipc = ctx.ipc.scope('register/misc');
  ipc.handle('create-desktop-shortcut', (_event, payload) => createDesktopShortcut(payload));
  ipc.handle('network:diagnose', () => diagnoseNetwork());
  ipc.handle('get-platform-name', () => getPlatformName(ctx.licenseCache));
  ipc.handle('get-wool-platforms', () => getWoolPlatforms(ctx.licenseCache));
  ipc.handle('get-tutorial-url', () => getTutorialUrl(ctx));
  ipc.handle('get-target-url', () => getTargetUrl(ctx.licenseCache));
  ipc.handle('get-app-session-id', () => getAppSessionId());
  ipc.handle('get-app-version', () => getAppVersion());
  ipc.handle('start-app-update', (_event, payload) => startAppUpdate(ctx, payload));
}

function getRuntimeConfig(licenseCache) {
  return typeof licenseCache?.getRuntimeConfig === 'function' ? licenseCache.getRuntimeConfig() : {};
}

/** @param {Record<string, any>} [options] */
async function createDesktopShortcut({ createShortcut } = {}) {
  try {
    if (!createShortcut) {
      console.log('[Shortcut] 用户选择不创建桌面快捷方式');
      return { ok: true };
    }
    const shortcut = require('../../utils/shortcut');
    return await shortcut.createDesktopShortcut();
  } catch (error) {
    console.error('[Shortcut] 创建桌面快捷方式失败:', error);
    return { ok: false, error: error.message };
  }
}

async function diagnoseNetwork() {
  try {
    console.log('[IPC] 开始网络连接诊断...');
    const result = await createHttpClient().diagnoseConnection();
    console.log('[IPC] 网络诊断完成:', result);
    return { ok: true, data: result };
  } catch (error) {
    console.error('[IPC] 网络诊断失败:', error);
    return { ok: false, error: error.message, message: '网络诊断执行失败' };
  }
}

function getPlatformName(licenseCache) {
  try {
    const config = getRuntimeConfig(licenseCache);
    const allowed = Array.isArray(config.allowedPlatforms) ? config.allowedPlatforms : [];
    return config.platformName || allowed[0] || 'AI-FREE';
  } catch (error) {
    console.error('[IPC] 获取平台名字失败:', error);
    return 'AI-FREE';
  }
}

function woolPlatformSubUrls(item) {
  const rawSubUrls = Array.isArray(item?.subUrls) ? item.subUrls : item?.sub_urls;
  if (!Array.isArray(rawSubUrls)) return [];
  return rawSubUrls.map((url) => String(url || '').trim()).filter(Boolean);
}

function woolPlatformFlag(item, camelField, snakeField) {
  return item?.[camelField] === true || item?.[snakeField] === true;
}

function woolPlatformQuota(item) {
  return item?.quota && typeof item.quota === 'object' ? { ...item.quota } : null;
}

function normalizeWoolPlatform(item) {
  const subUrls = woolPlatformSubUrls(item);
  const targetUrl = firstWoolPlatformText(item, ['targetUrl', 'target_url']) || subUrls[0] || '';
  return {
    name: firstWoolPlatformText(item, ['name', 'platform', 'platform_name']),
    platform: firstWoolPlatformText(item, ['platform', 'name', 'platform_name']),
    targetUrl,
    subUrls,
    launchOnly: woolPlatformFlag(item, 'launchOnly', 'launch_only'),
    permissionGranted: woolPlatformFlag(item, 'permissionGranted', 'permission_granted'),
    quota: woolPlatformQuota(item),
  };
}

function firstWoolPlatformText(item, keys) {
  const key = keys.find((candidate) => item?.[candidate]);
  return String(key ? item[key] : '').trim();
}

function getWoolPlatforms(licenseCache) {
  try {
    const items = getRuntimeConfig(licenseCache).woolPlatforms;
    return (Array.isArray(items) ? items : []).map(normalizeWoolPlatform)
      .filter((item) => item.name && item.targetUrl);
  } catch (error) {
    console.error('[IPC] 获取羊毛平台列表失败:', error);
    return [];
  }
}

async function getTutorialUrl({ httpClient, licenseCache, ui }) {
  try {
    const remoteUrl = await fetchRemoteTutorialUrl(httpClient, licenseCache, ui);
    if (remoteUrl) return remoteUrl;
    return getRuntimeConfig(licenseCache).tutorialUrl || DEFAULT_TUTORIAL_URL;
  } catch (error) {
    console.error('[IPC] 获取教程链接失败:', error);
    return DEFAULT_TUTORIAL_URL;
  }
}

async function fetchRemoteTutorialUrl(httpClient, licenseCache, ui) {
  if (typeof httpClient?.getTutorialUrl !== 'function') return '';
  const response = await httpClient.getTutorialUrl();
  const tutorialUrl = String(response?.tutorialUrl || response?.tutorial_url || '').trim();
  if (response?.ok !== true || !tutorialUrl) return '';
  licenseCache?.setRuntimeConfig?.({ tutorialUrl });
  if (typeof ui?.syncTutorialTabUrl === 'function') await ui.syncTutorialTabUrl(tutorialUrl);
  return tutorialUrl;
}

function getTargetUrl(licenseCache) {
  try {
    return getRuntimeConfig(licenseCache).targetUrl || 'https://dreamina.capcut.com/ai-tool/home?';
  } catch (error) {
    console.error('[IPC] 获取目标链接失败:', error);
    return 'https://dreamina.capcut.com/ai-tool/home?';
  }
}

function getAppSessionId() {
  try { return { ok: true, sessionId: appContext.getSessionId() || '' }; }
  catch (error) { return { ok: false, error: error.message || String(error), sessionId: '' }; }
}

function getAppVersion() {
  try { return { ok: true, version: app.getVersion() }; }
  catch (error) { return { ok: false, error: error.message || String(error), version: '' }; }
}

async function startAppUpdate(ctx, payload = {}) {
  try {
    const operation = typeof ctx.startAppUpdate === 'function' ? ctx.startAppUpdate : ctx.ui?.startAppUpdate;
    console.warn('[IPC] start-app-update 函数来源', JSON.stringify({
      fromRoot: typeof ctx.startAppUpdate === 'function', fromUi: typeof ctx.ui?.startAppUpdate === 'function',
    }));
    console.warn('[IPC] start-app-update 被调用', JSON.stringify(summarizeUpdatePayload(payload)));
    if (typeof operation !== 'function') return { ok: false, message: '更新功能不可用' };
    const result = await operation(payload);
    console.warn('[IPC] start-app-update 返回', JSON.stringify(result));
    return result;
  } catch (error) {
    console.error('[IPC] 启动应用更新失败:', error);
    return { ok: false, error: error.message || String(error) };
  }
}

module.exports = { registerMiscIPC };
