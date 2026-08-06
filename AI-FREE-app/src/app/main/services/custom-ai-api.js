const axios = require('axios');
const { normalizeCustomAiApiConfig } = require('../utils/ai-control-settings');
const { normalizeToolCallMessage } = require('../lib/ai-tool-call-normalizer');

function resolveChatCompletionsUrl(baseUrl) {
  const raw = String(baseUrl || '').trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new Error('自定义 API 地址无效，请填写完整的 HTTP(S) 地址');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('自定义 API 仅支持 HTTP(S) 地址');
  }
  parsed.hash = '';
  parsed.search = '';
  const pathname = parsed.pathname.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(pathname)) {
    parsed.pathname = pathname;
  } else if (/\/v\d+$/i.test(pathname)) {
    parsed.pathname = `${pathname}/chat/completions`;
  } else {
    parsed.pathname = `${pathname}/v1/chat/completions`.replace(/\/{2,}/g, '/');
  }
  return parsed.toString();
}

function normalizeMessages(messages = []) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    const role = String(message?.role || 'user');
    const normalized = { role, content: message?.content ?? '' };
    if (role === 'assistant' && Array.isArray(message?.tool_calls)) {
      normalized.tool_calls = message.tool_calls;
    }
    if (role === 'tool') {
      normalized.tool_call_id = String(message?.tool_call_id || '');
      if (message?.name) normalized.name = String(message.name);
    }
    return normalized;
  });
}

function messagesHaveImageInput(messages = []) {
  return (Array.isArray(messages) ? messages : []).some((message) => (
    Array.isArray(message?.content) && message.content.some((part) => (
      String(part?.type || '').toLowerCase() === 'image_url'
      && Boolean(part?.image_url?.url)
    ))
  ));
}

function buildCustomAiRequest(normalized, messages, options) {
  const headers = { 'Content-Type': 'application/json' };
  if (normalized.apiKey) headers.Authorization = `Bearer ${normalized.apiKey}`;
  const payload = {
    model: normalized.model,
    messages: normalizeMessages(messages),
    stream: false,
  };
  if (Array.isArray(options.tools) && options.tools.length) payload.tools = options.tools;
  return { headers, payload };
}

function getCustomAiResponseData(response) {
  return response && response.data && typeof response.data === 'object' ? response.data : {};
}

function getCustomAiErrorDetail(data, status) {
  const error = data && data.error;
  return (error && error.message) || (data && data.message) || `HTTP ${status}`;
}

function normalizeCustomAiSuccess(data) {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const message = choices[0] && choices[0].message;
  if (!message || typeof message !== 'object') {
    return { ok: false, message: '自定义 API 返回格式无效：缺少 choices[0].message' };
  }
  const normalizedMessage = normalizeToolCallMessage(message);
  return {
    ok: true,
    message: {
      role: 'assistant',
      content: normalizedMessage.content,
      reasoning: String(message.reasoning_content || message.reasoning || ''),
      tool_calls: normalizedMessage.toolCalls,
    },
    usage: data.usage || null,
    custom_api: true,
  };
}

async function sendCustomAIControlMessage(config, messages, options = {}) {
  const normalized = normalizeCustomAiApiConfig(config);
  if (!normalized.enabled || !normalized.baseUrl || !normalized.model) {
    return { ok: false, message: '自定义 API 尚未配置完整' };
  }
  if (messagesHaveImageInput(messages) && !normalized.supportsImageInput) {
    return {
      ok: false,
      message: `当前模型“${normalized.name}”未启用图片输入，无法读取 browser_screenshot 截图。请在自定义 API 配置中开启“支持图片输入”，或切换到视觉模型。`,
      errorCode: 'MODEL_IMAGE_INPUT_UNSUPPORTED',
    };
  }

  const { headers, payload } = buildCustomAiRequest(normalized, messages, options);

  try {
    const response = await axios.post(resolveChatCompletionsUrl(normalized.baseUrl), payload, {
      headers,
      signal: options.signal,
      timeout: 240000,
      maxContentLength: 20 * 1024 * 1024,
      maxBodyLength: 20 * 1024 * 1024,
      validateStatus: () => true,
    });
    const data = getCustomAiResponseData(response);
    if (response.status < 200 || response.status >= 300) {
      const detail = getCustomAiErrorDetail(data, response.status);
      return { ok: false, message: `自定义 API 请求失败：${detail}` };
    }
    return normalizeCustomAiSuccess(data);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return { ok: false, message: `自定义 API 请求失败：${message}` };
  }
}

module.exports = {
  messagesHaveImageInput,
  normalizeMessages,
  resolveChatCompletionsUrl,
  sendCustomAIControlMessage,
};
