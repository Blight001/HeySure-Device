'use strict';

const {
  DEFAULT_AI_CONTROL_MCP_CALL_LIMIT,
  MIN_AI_CONTROL_MCP_CALL_LIMIT,
  MAX_AI_CONTROL_MCP_CALL_LIMIT,
  getCustomAiApiConfig,
  getAiControlMcpCallLimit,
  normalizeCustomAiApiConfig,
  normalizeAiControlMcpCallLimit,
  toPublicCustomAiApiConfig,
} = require('../../utils/ai-control-settings');
const { createVipRequiredResult, resolveVipAccess } = require('../../utils/vip-access');

function mergeAiControlSettings(store, patch) {
  const current = store && typeof store === 'object' ? store : {};
  return {
    ...current,
    aiControlSettings: {
      ...(current.aiControlSettings && typeof current.aiControlSettings === 'object' ? current.aiControlSettings : {}),
      ...patch,
    },
  };
}

function buildCustomApiConfig(currentStore, payload, clear) {
  if (clear) return normalizeCustomAiApiConfig({});
  const previous = getCustomAiApiConfig(currentStore);
  return normalizeCustomAiApiConfig({
    enabled: payload.enabled !== false,
    name: payload.name,
    baseUrl: payload.baseUrl,
    model: payload.model,
    supportsImageInput: payload.supportsImageInput,
    apiKey: Object.prototype.hasOwnProperty.call(payload, 'apiKey') ? payload.apiKey : previous.apiKey,
  });
}

function validateCustomApiConfig(config, clear) {
  if (clear) return;
  if (!config.baseUrl) throw new Error('请输入自定义 API 地址');
  if (!/^https?:\/\//i.test(config.baseUrl)) throw new Error('API 地址必须以 http:// 或 https:// 开头');
  if (!config.model) throw new Error('请输入模型名称');
}

function createAiSettingsService(deps = {}) {
  function getSettings() {
    return {
      ok: true,
      settings: { mcpCallLimit: getAiControlMcpCallLimit(deps.readStore()) },
      defaults: { mcpCallLimit: DEFAULT_AI_CONTROL_MCP_CALL_LIMIT },
      limits: { mcpCallLimit: { min: MIN_AI_CONTROL_MCP_CALL_LIMIT, max: MAX_AI_CONTROL_MCP_CALL_LIMIT } },
    };
  }

  function setSettings(payload = {}) {
    const rawLimit = payload.mcpCallLimit;
    if (!Number.isFinite(Number(rawLimit))) throw new Error('MCP 调用上限必须是有效数字');
    const mcpCallLimit = normalizeAiControlMcpCallLimit(rawLimit);
    if (!deps.writeStore(mergeAiControlSettings(deps.readStore(), { mcpCallLimit }))) {
      throw new Error('AI 控制设置未能写入本地配置');
    }
    return { ok: true, settings: { mcpCallLimit } };
  }

  function getCustomApi() {
    if (!resolveVipAccess(deps.licenseCache?.getSnapshot?.() || {}).isVip) {
      return createVipRequiredResult('自定义模型');
    }
    return { ok: true, config: toPublicCustomAiApiConfig(getCustomAiApiConfig(deps.readStore())) };
  }

  function setCustomApi(payload = {}) {
    const clear = payload.clear === true;
    if (!clear && !resolveVipAccess(deps.licenseCache?.getSnapshot?.() || {}).isVip) {
      return createVipRequiredResult('自定义模型');
    }
    const currentStore = deps.readStore();
    const next = buildCustomApiConfig(currentStore, payload, clear);
    validateCustomApiConfig(next, clear);
    if (!deps.writeStore(mergeAiControlSettings(currentStore, { customApi: next }))) {
      throw new Error('自定义 API 未能写入本地配置');
    }
    return { ok: true, config: toPublicCustomAiApiConfig(next) };
  }

  return { getCustomApi, getSettings, setCustomApi, setSettings };
}

module.exports = { buildCustomApiConfig, createAiSettingsService, mergeAiControlSettings, validateCustomApiConfig };
