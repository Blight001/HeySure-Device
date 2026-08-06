'use strict';

const {
  CUSTOM_AI_MODEL_ID,
  getCustomAiApiConfig,
  isCustomAiApiConfigured,
} = require('../../utils/ai-control-settings');
const { resolveVipAccess } = require('../../utils/vip-access');
const { normalizeAccountSession } = require('../../utils/account-session');
const { callOptional, firstText } = require('../../../shared/safe-values');

function createCustomModel(store, licenseCache) {
  const config = getCustomAiApiConfig(store);
  const vip = resolveVipAccess(callOptional(licenseCache, 'getSnapshot') || {}).isVip;
  return vip && isCustomAiApiConfigured(config)
    ? {
      id: CUSTOM_AI_MODEL_ID,
      name: config.name,
      model: config.model,
      custom_api: true,
      supports_image_input: config.supportsImageInput,
    }
    : null;
}

function remoteUnavailable(customModel, message = 'AI 服务尚未就绪') {
  return customModel
    ? { ok: true, models: [customModel], quota: null, remoteError: message }
    : { ok: false, message };
}

function createAiModelService(deps = {}) {
  const { readStoreConfigSafe, licenseCache, getGlobalHttpClient } = deps;
  async function getModels() {
    const store = readStoreConfigSafe();
    const credentials = normalizeAccountSession(store?.userCredentials || {});
    const key = firstText(credentials.key).trim();
    const deviceId = firstText(credentials.deviceId).trim();
    const customModel = createCustomModel(store, licenseCache);
    if ((!key || !deviceId) && customModel) return { ok: true, models: [customModel], quota: null };
    const httpClient = callOptional(deps, 'getGlobalHttpClient');
    if (!httpClient || typeof httpClient.getAIControlModels !== 'function') {
      return remoteUnavailable(customModel);
    }
    const result = await httpClient.getAIControlModels(key, deviceId);
    if (!result || result.ok !== true) {
      return customModel
        ? remoteUnavailable(customModel, firstText(result && result.message, result && result.error))
        : result;
    }
    return {
      ...result,
      models: [
        ...(Array.isArray(result.models) ? result.models : []),
        ...(customModel ? [customModel] : []),
      ],
    };
  }

  return { getModels };
}

module.exports = { createAiModelService, createCustomModel, remoteUnavailable };
