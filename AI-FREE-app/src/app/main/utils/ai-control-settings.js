const DEFAULT_AI_CONTROL_MCP_CALL_LIMIT = 100;
const MIN_AI_CONTROL_MCP_CALL_LIMIT = 1;
const MAX_AI_CONTROL_MCP_CALL_LIMIT = 1000;
const CUSTOM_AI_MODEL_ID = '__custom_openai_api__';

function normalizeAiControlMcpCallLimit(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_AI_CONTROL_MCP_CALL_LIMIT;
  return Math.min(
    MAX_AI_CONTROL_MCP_CALL_LIMIT,
    Math.max(MIN_AI_CONTROL_MCP_CALL_LIMIT, Math.trunc(numeric)),
  );
}

function getAiControlMcpCallLimit(store = {}) {
  return normalizeAiControlMcpCallLimit(store?.aiControlSettings?.mcpCallLimit);
}

function normalizeCustomAiApiConfig(value = {}) {
  /** @type {Record<string, any>} */
  const source = value && typeof value === 'object' ? value : {};
  return {
    enabled: source.enabled === true,
    name: String(source.name || '自定义 API').trim().slice(0, 80) || '自定义 API',
    baseUrl: String(source.baseUrl || '').trim().slice(0, 2048),
    apiKey: String(source.apiKey || '').trim().slice(0, 4096),
    model: String(source.model || '').trim().slice(0, 200),
    supportsImageInput: source.supportsImageInput === true,
  };
}

function getCustomAiApiConfig(store = {}) {
  return normalizeCustomAiApiConfig(store?.aiControlSettings?.customApi);
}

function isCustomAiApiConfigured(config = {}) {
  const normalized = normalizeCustomAiApiConfig(config);
  return normalized.enabled && Boolean(normalized.baseUrl && normalized.model);
}

function isCustomAiModelId(modelId) {
  return String(modelId || '').trim() === CUSTOM_AI_MODEL_ID;
}

function toPublicCustomAiApiConfig(config = {}) {
  const normalized = normalizeCustomAiApiConfig(config);
  return {
    enabled: normalized.enabled,
    name: normalized.name,
    baseUrl: normalized.baseUrl,
    model: normalized.model,
    supportsImageInput: normalized.supportsImageInput,
    hasApiKey: Boolean(normalized.apiKey),
  };
}

module.exports = {
  DEFAULT_AI_CONTROL_MCP_CALL_LIMIT,
  MIN_AI_CONTROL_MCP_CALL_LIMIT,
  MAX_AI_CONTROL_MCP_CALL_LIMIT,
  CUSTOM_AI_MODEL_ID,
  getCustomAiApiConfig,
  getAiControlMcpCallLimit,
  isCustomAiApiConfigured,
  isCustomAiModelId,
  normalizeCustomAiApiConfig,
  normalizeAiControlMcpCallLimit,
  toPublicCustomAiApiConfig,
};
