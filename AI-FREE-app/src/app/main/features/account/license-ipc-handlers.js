const {
  getValidationFailureMessage,
  isValidationSuccess,
} = require('../../utils/license-response');
const { normalizeValidationRuntimeConfig } = require('../../lib/http-client');
const { firstText } = require('../../../shared/safe-values');

function text(...values) {
  return firstText(...values).trim();
}

function errorMessage(error, fallback = '') {
  return text(error && error.message, error, fallback);
}

async function runExclusive(state, key, task) {
  if (state[key]) return state[key];
  state[key] = task();
  try {
    return await state[key];
  } finally {
    state[key] = null;
  }
}

function credentialsFrom(deps) {
  if (!deps.licenseCache || typeof deps.licenseCache.getCredentials !== 'function') return {};
  return deps.licenseCache.getCredentials();
}

function cacheRuntimeConfig(deps, value) {
  if (deps.licenseCache && typeof deps.licenseCache.setRuntimeConfig === 'function') {
    deps.licenseCache.setRuntimeConfig(value);
  }
}

async function refreshWoolPlatformsTask(deps) {
  try {
    const credentials = credentialsFrom(deps);
    const key = text(credentials.key);
    const deviceId = text(credentials.deviceId);
    if (!key || !deviceId) {
      cacheRuntimeConfig(deps, { woolPlatforms: [] });
      return { ok: false, authenticated: false, woolPlatforms: [], message: '请先登录账号' };
    }
    if (!deps.httpClient || typeof deps.httpClient.validateSession !== 'function') {
      return { ok: false, message: '羊毛平台服务尚未就绪' };
    }
    const validation = await deps.httpClient.validateSession(key, deviceId);
    if (!isValidationSuccess(validation)) {
      cacheRuntimeConfig(deps, { woolPlatforms: [] });
      return { ok: false, woolPlatforms: [], message: getValidationFailureMessage(validation, '刷新羊毛平台失败') };
    }
    const normalized = normalizeValidationRuntimeConfig(validation);
    const woolPlatforms = Array.isArray(normalized.woolPlatforms) ? normalized.woolPlatforms : [];
    cacheRuntimeConfig(deps, { woolPlatforms });
    return { ok: true, woolPlatforms };
  } catch (error) {
    cacheRuntimeConfig(deps, { woolPlatforms: [] });
    return { ok: false, woolPlatforms: [], message: errorMessage(error) };
  }
}

async function readPublicTutorial(deps) {
  if (!deps.httpClient || typeof deps.httpClient.getTutorialUrl !== 'function') return '';
  const response = await deps.httpClient.getTutorialUrl();
  const tutorialUrl = text(response && response.tutorialUrl, response && response.tutorial_url);
  return response && response.ok === true ? tutorialUrl : '';
}

async function readValidatedTutorial(deps) {
  const credentials = credentialsFrom(deps);
  const key = text(credentials.key);
  const deviceId = text(credentials.deviceId);
  if (!key || !deviceId) return { ok: false, authenticated: false, message: '请先登录账号' };
  if (!deps.httpClient || typeof deps.httpClient.validateSession !== 'function') {
    return { ok: false, message: '教程配置服务尚未就绪' };
  }
  const validation = await deps.httpClient.validateSession(key, deviceId);
  if (!isValidationSuccess(validation)) {
    return { ok: false, message: getValidationFailureMessage(validation, '刷新教程链接失败') };
  }
  const tutorialUrl = text(normalizeValidationRuntimeConfig(validation).tutorialUrl);
  return tutorialUrl
    ? { ok: true, tutorialUrl }
    : { ok: false, message: '服务器未配置教程链接' };
}

async function refreshTutorialTask(deps) {
  try {
    const publicUrl = await readPublicTutorial(deps);
    const result = publicUrl ? { ok: true, tutorialUrl: publicUrl } : await readValidatedTutorial(deps);
    if (result.ok) cacheRuntimeConfig(deps, { tutorialUrl: result.tutorialUrl });
    return result;
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

async function runOptionalStep(label, task) {
  try {
    return await task();
  } catch (error) {
    console.warn(label, errorMessage(error));
    return undefined;
  }
}

async function requestUnbind(deps, key, deviceId) {
  if (deps.httpClient && typeof deps.httpClient.unbindDevice === 'function') {
    return deps.httpClient.unbindDevice(key, deviceId);
  }
  if (!deps.http || typeof deps.http.postJson !== 'function') throw new Error('解绑客户端不可用');
  const serverBase = deps.getServerBase();
  if (!serverBase) throw new Error('服务器地址未配置');
  const response = await deps.http.postJson(`${serverBase.replace(/\/+$/, '')}/api/unbind_device`, {
    key,
    device_id: deviceId,
    deviceId,
  });
  const body = response.body && typeof response.body === 'object' ? response.body : {};
  return { ok: response.ok, status: response.status, ...body };
}

async function unbindDevice(deps, _event, payload) {
  try {
    const key = text(payload.key);
    const deviceId = text(payload.device_id, payload.deviceId);
    if (!key) return { ok: false, message: '缺少登录状态' };
    if (!deviceId) return { ok: false, message: '缺少设备号' };
    const response = await requestUnbind(deps, key, deviceId);
    if (!response || !response.ok) return response || { ok: false, message: '解绑失败' };
    await runOptionalStep('[解绑] 更新本地凭证状态失败:', async () => {
      if (deps.licenseCache && typeof deps.licenseCache.setUnboundState === 'function') {
        deps.licenseCache.setUnboundState({ key, deviceId });
      }
    });
    return response;
  } catch (error) {
    console.error('[解绑] 解绑过程出错:', errorMessage(error));
    return { ok: false, message: errorMessage(error, '解绑失败') };
  }
}

async function refreshSubscriptionUrl(deps) {
  try {
    if (!deps.httpClient) return { ok: false, error: 'TCP客户端不可用' };
    const last = deps.accountStorage.getLastUsedAccount();
    if (!last.ok || !last.account) {
      return { ok: false, error: '没有找到有效的账号信息，请先登录账号' };
    }
    let response;
    try {
      response = await deps.httpClient.getClientConfig(last.account.key, last.account.deviceId);
    } catch (error) {
      return { ok: false, error: `获取配置失败: ${errorMessage(error)}` };
    }
    if (response && response.ok && response.proxy_subscription_url) {
      return { ok: true, subscriptionUrl: response.proxy_subscription_url };
    }
    return { ok: false, error: '获取配置失败或响应格式不正确' };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function createLicenseIpcHandlers(deps) {
  const inFlight = { wool: null, tutorial: null };
  return {
    refreshWoolPlatforms: () => runExclusive(inFlight, 'wool', () => refreshWoolPlatformsTask(deps)),
    refreshTutorialUrl: () => runExclusive(inFlight, 'tutorial', () => refreshTutorialTask(deps)),
    unbindDevice: (event, payload) => unbindDevice(deps, event, payload),
    refreshSubscriptionUrl: () => refreshSubscriptionUrl(deps),
  };
}

module.exports = { createLicenseIpcHandlers };
