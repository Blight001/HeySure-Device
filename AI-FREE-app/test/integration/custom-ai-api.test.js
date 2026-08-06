'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const axios = require('axios');

const {
  CUSTOM_AI_MODEL_ID,
  getCustomAiApiConfig,
  isCustomAiApiConfigured,
  isCustomAiModelId,
  toPublicCustomAiApiConfig,
} = require('../../src/app/main/utils/ai-control-settings');
const {
  normalizeMessages,
  resolveChatCompletionsUrl,
  sendCustomAIControlMessage,
} = require('../../src/app/main/services/custom-ai-api');

test('自定义 API 配置可识别且公开配置不会泄露 API Key', () => {
  const config = getCustomAiApiConfig({
    aiControlSettings: {
      customApi: {
        enabled: true,
        name: '本地模型',
        baseUrl: 'http://127.0.0.1:11434/v1',
        apiKey: 'secret',
        model: 'qwen3',
      },
    },
  });
  assert.equal(isCustomAiApiConfigured(config), true);
  assert.equal(isCustomAiModelId(CUSTOM_AI_MODEL_ID), true);
  assert.deepEqual(toPublicCustomAiApiConfig(config), {
    enabled: true,
    name: '本地模型',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen3',
    supportsImageInput: false,
    hasApiKey: true,
  });
});

test('自定义 API 地址兼容 Base URL 与完整 Chat Completions URL', () => {
  assert.equal(
    resolveChatCompletionsUrl('https://api.openai.com/v1'),
    'https://api.openai.com/v1/chat/completions',
  );
  assert.equal(
    resolveChatCompletionsUrl('http://127.0.0.1:11434'),
    'http://127.0.0.1:11434/v1/chat/completions',
  );
  assert.equal(
    resolveChatCompletionsUrl('https://example.com/api/v1/chat/completions'),
    'https://example.com/api/v1/chat/completions',
  );
  assert.equal(resolveChatCompletionsUrl('https://example.com/root/?q=1#hash'), 'https://example.com/root/v1/chat/completions');
  assert.throws(() => resolveChatCompletionsUrl('not a url'), /地址无效/);
  assert.throws(() => resolveChatCompletionsUrl('file:///tmp/model'), /仅支持 HTTP/);
});

test('自定义 API 消息归一化保留工具协议并剔除私有字段', () => {
  assert.deepEqual(normalizeMessages(null), []);
  assert.deepEqual(normalizeMessages([
    null,
    { role: 'assistant', content: null, tool_calls: [{ id: 'call' }], private: true },
    { role: 'tool', content: 42, tool_call_id: 9, name: 'lookup' },
    { role: 'tool' },
  ]), [
    { role: 'user', content: '' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call' }] },
    { role: 'tool', content: 42, tool_call_id: '9', name: 'lookup' },
    { role: 'tool', content: '', tool_call_id: '' },
  ]);
});

test('自定义 API 请求使用 OpenAI 兼容协议并保留工具调用', async (t) => {
  const originalPost = axios.post;
  t.after(() => { axios.post = originalPost; });
  let captured;
  axios.post = async (url, payload, options) => {
    captured = { url, payload, options };
    return {
      status: 200,
      data: {
        choices: [{ message: { content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'open_page', arguments: '{}' } }] } }],
      },
    };
  };
  const result = await sendCustomAIControlMessage({
    enabled: true,
    baseUrl: 'https://example.com/v1',
    apiKey: 'token',
    model: 'demo-model',
  }, [{ role: 'user', content: '打开网页', private_field: true }], {
    tools: [{ type: 'function', function: { name: 'open_page', parameters: { type: 'object' } } }],
  });
  assert.equal(result.ok, true);
  assert.equal(captured.url, 'https://example.com/v1/chat/completions');
  assert.equal(captured.options.headers.Authorization, 'Bearer token');
  assert.equal(captured.payload.model, 'demo-model');
  assert.equal(captured.payload.messages[0].private_field, undefined);
  assert.equal(result.message.tool_calls[0].function.name, 'open_page');
});

test('自定义 API 请求覆盖未配置、HTTP 错误、响应变体与网络错误', async (t) => {
  const originalPost = axios.post;
  t.after(() => { axios.post = originalPost; });
  assert.deepEqual(await sendCustomAIControlMessage({}, []), { ok: false, message: '自定义 API 尚未配置完整' });
  const config = { enabled: true, baseUrl: 'https://example.com', model: 'fixture' };
  axios.post = async () => ({ status: 429, data: { error: { message: 'rate limited' } } });
  assert.match((await sendCustomAIControlMessage(config, [])).message, /rate limited/);
  axios.post = async () => ({ status: 500, data: { message: 'server failed' } });
  assert.match((await sendCustomAIControlMessage(config, [])).message, /server failed/);
  axios.post = async () => ({ status: 503, data: 'plain' });
  assert.match((await sendCustomAIControlMessage(config, [])).message, /HTTP 503/);
  axios.post = async () => ({ status: 200, data: {} });
  assert.match((await sendCustomAIControlMessage(config, [])).message, /缺少 choices/);
  axios.post = async () => ({ status: 200, data: { choices: [{ message: {
    content: ['hello', { text: ' world' }, { content: '!' }, null], reasoning: 'thought', tool_calls: null,
  } }], usage: { total_tokens: 3 } } });
  const success = await sendCustomAIControlMessage(config, []);
  assert.equal(success.message.content, 'hello world!');
  assert.equal(success.message.reasoning, 'thought');
  assert.deepEqual(success.message.tool_calls, []);
  axios.post = async () => { throw new Error('network offline'); };
  assert.match((await sendCustomAIControlMessage(config, [])).message, /network offline/);
});

test('未启用图片输入的自定义模型在请求前返回明确错误', async (t) => {
  const originalPost = axios.post;
  t.after(() => { axios.post = originalPost; });
  let requests = 0;
  axios.post = async () => { requests += 1; return {}; };
  const result = await sendCustomAIControlMessage({
    enabled: true,
    name: '纯文本模型',
    baseUrl: 'https://example.com/v1',
    model: 'text-only',
  }, [{ role: 'user', content: [
    { type: 'text', text: '分析截图' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
  ] }]);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'MODEL_IMAGE_INPUT_UNSUPPORTED');
  assert.match(result.message, /纯文本模型.*未启用图片输入/);
  assert.equal(requests, 0);
});

test('自定义 API 归一化旧式 function_call 与 Anthropic tool_use', async (t) => {
  const originalPost = axios.post;
  t.after(() => { axios.post = originalPost; });
  const config = { enabled: true, baseUrl: 'https://example.com', model: 'fixture' };
  const responses = [
    { choices: [{ message: { content: '', function_call: { name: 'software_window', arguments: '{"action":"list"}' } } }] },
    { choices: [{ message: { content: [
      { type: 'text', text: '正在获取窗口' },
      { type: 'tool_use', id: 'anthropic-1', name: 'software_window', input: { action: 'list' } },
    ] } }] },
  ];
  axios.post = async () => ({ status: 200, data: responses.shift() });
  const legacy = await sendCustomAIControlMessage(config, []);
  assert.equal(legacy.message.tool_calls[0].function.name, 'software_window');
  assert.deepEqual(JSON.parse(legacy.message.tool_calls[0].function.arguments), { action: 'list' });
  const anthropic = await sendCustomAIControlMessage(config, []);
  assert.equal(anthropic.message.content, '正在获取窗口');
  assert.equal(anthropic.message.tool_calls[0].id, 'anthropic-1');
  assert.deepEqual(JSON.parse(anthropic.message.tool_calls[0].function.arguments), { action: 'list' });
});
