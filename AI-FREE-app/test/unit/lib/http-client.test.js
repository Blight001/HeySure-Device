'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const calls = [];
let base = '';
let requestHandler = async (options) => ({ ok: true, status: 200, echo: options });
let streamHandler = async (...args) => ({ ok: true, args });
const configPath = require.resolve('../../../src/app/main/config');
const httpPath = require.resolve('../../../src/app/main/lib/http');
const transportPath = require.resolve('../../../src/app/main/lib/http-client/transport-request');
const serverModePath = require.resolve('../../../src/app/main/utils/server-mode');
const validationPath = require.resolve('../../../src/app/main/features/account/validation-runtime-config');
const targetPath = require.resolve('../../../src/app/main/lib/http-client');

require.cache[configPath] = { exports: {
  NETWORK_DIAG_CONFIG: { REQUEST_TIMEOUT: 5000 },
  getServerBase: () => base,
  setRuntimeServerBase: (value) => { base = value; },
} };
require.cache[httpPath] = { exports: {
  getJson: async () => ({}),
  postJson: async () => ({}),
  postEventStream: (...args) => streamHandler(...args),
} };
require.cache[transportPath] = { exports: {
  executeHttpRequest: async (options) => {
    calls.push(options);
    return requestHandler(options);
  },
} };
require.cache[serverModePath] = { exports: {
  isServerBaseAllowedForMode: (value) => /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/.test(value),
} };
require.cache[validationPath] = { exports: { normalizeValidationRuntimeConfig: (value) => ({ normalized: value }) } };
delete require.cache[targetPath];
const { createHttpClient, normalizeValidationRuntimeConfig } = require(targetPath);

test.beforeEach(() => {
  calls.length = 0;
  base = '';
  requestHandler = async (options) => ({ ok: true, status: 200, echo: options });
  streamHandler = async (...args) => ({ ok: true, args });
});

test('client normalizes and synchronizes allowed runtime server addresses', () => {
  const firstWindow = { id: 1 };
  const client = createHttpClient({ mainWindow: firstWindow });
  assert.equal(client.mainWindow, firstWindow);
  assert.equal(client.transportMode, 'http');
  assert.equal(client._normalizeRuntimeServerBase('127.0.0.1:58111/'), 'http://127.0.0.1:58111');
  assert.equal(client._normalizeRuntimeServerBase('https://localhost:58111/api/'), 'https://localhost:58111/api');
  assert.equal(client._normalizeRuntimeServerBase('https://example.com'), '');
  assert.equal(client._normalizeRuntimeServerBase('http://['), '');
  assert.equal(client._extractRuntimeServerBase({ data: { address_HTTP: '127.0.0.1:58111' } }), 'http://127.0.0.1:58111');
  assert.equal(client._extractRuntimeServerBase(null), '');
  assert.equal(client._syncRuntimeServerBase({ result: { server_base: 'http://localhost:59000/' } }), 'http://localhost:59000');
  assert.equal(base, 'http://localhost:59000');
  assert.deepEqual(client._getClientGatewayFallbackBases(), ['http://localhost:58111']);
  createHttpClient({ mainWindow: { id: 2 } });
  assert.equal(client.mainWindow.id, 2);
  assert.deepEqual(normalizeValidationRuntimeConfig({ a: 1 }), { normalized: { a: 1 } });
});

test('request wrappers preserve endpoint, payload, timeout and transport mode', async () => {
  const client = createHttpClient();
  base = 'http://127.0.0.1:59000';
  client.runtimeServerBase = '';
  const operations = [
    ['validateSession', ['afs_test', 'device'], '/api/account/session'],
    ['logoutAccount', ['afs_test'], '/api/account/logout'],
    ['getTutorialUrl', [], '/api/get_tutorial_url'],
    ['fetchCookie', ['key', 'dream', 'device'], '/api/fetch_cookie'],
    ['unbindDevice', ['key', 'device'], '/api/unbind_device'],
    ['getProxyStatus', [], '/api/get_proxy_status'],
    ['getPacConfig', ['key', 'device'], '/api/get_pac_config'],
    ['controlProxy', ['key', 'device', 'start'], '/api/control_proxy'],
    ['redeemAIControlGiftCode', ['key', 'device', 'gift'], '/api/ai-control/gift-codes/redeem'],
    ['redeemWoolGiftCode', ['key', 'device', 'gift'], '/api/wool-gift-codes/redeem'],
    ['redeemVipGiftCode', ['key', 'device', 'gift'], '/api/vip-gift-codes/redeem'],
    ['getVipPlans', ['key', 'device'], '/api/vip/plans'],
    ['getProxyTrafficQuota', ['key', 'device'], '/api/proxy/client/quota'],
    ['createProxyTrafficSession', ['key', 'device'], '/api/proxy/client/session'],
    ['reportProxyTraffic', [{ bytes: 123 }], '/api/proxy/client/usage'],
    ['redeemProxyTrafficGiftCode', ['key', 'device', 'gift'], '/api/proxy/gift-codes/redeem'],
    ['sendAIControlMessage', ['key', 'device', 'model', [{ role: 'user' }], { tools: [{ name: 'tool' }], runId: 'run' }], '/api/ai-control/chat'],
  ];
  for (const [method, args, expectedPath] of operations) {
    const result = await client[method](...args);
    assert.equal(result.ok, true, method);
    assert.equal(result.transportMode, 'http', method);
    assert.equal(calls.at(-1).path, expectedPath, method);
  }
  assert.equal(calls.find((item) => item.path === '/api/proxy/client/usage').timeoutMs, 15000);
  assert.equal(calls.find((item) => item.path === '/api/ai-control/chat').timeoutMs, 120000);
  assert.deepEqual(calls.find((item) => item.path === '/api/ai-control/chat').data.tools, [{ name: 'tool' }]);
  client.close();
});

test('request failures, diagnostics and client config fallback return stable results', async () => {
  const client = createHttpClient();
  client.runtimeServerBase = '';
  base = '';
  const missing = await client.diagnoseConnection();
  assert.equal(missing.httpConnection, false);
  assert.match(missing.httpError, /未配置/);

  base = 'http://127.0.0.1:59000';
  requestHandler = async (options) => {
    if (options.path === '/api/user_announcement') return { ok: true };
    throw new Error('network down');
  };
  assert.equal((await client.diagnoseConnection()).httpConnection, true);
  const failed = await client.validateSession('afs_test', 'device');
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 0);
  assert.equal(failed.transportMode, 'http');

  let attempt = 0;
  requestHandler = async () => {
    attempt += 1;
    return attempt === 1 ? { ok: false, message: 'GET unsupported' } : { ok: true, data: { config: true } };
  };
  const config = await client.getClientConfig('key value', 'device');
  assert.equal(config.ok, true);
  assert.equal(config.transportMode, 'http');
  assert.match(calls.at(-2).path, /session_token=key\+value/);
  assert.equal(calls.at(-1).method, 'POST');

  requestHandler = async () => ({ ok: false, error: 'rejected' });
  const rejected = await client.getClientConfig('key', 'device');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.transportMode, 'http');

  requestHandler = async () => { throw new Error('config offline'); };
  const offline = await client.getClientConfig('key', 'device');
  assert.equal(offline.ok, false);
  assert.match(offline.error, /config offline/);
});

test('AI models use client-gateway fallback and stream requests forward cancellation', async () => {
  const client = createHttpClient();
  client.runtimeServerBase = 'http://127.0.0.1:59000/control';
  let requestCount = 0;
  requestHandler = async (options) => {
    requestCount += 1;
    if (requestCount === 1) return { ok: false, error: 'primary unavailable' };
    assert.equal(options.getServerBase(), 'http://127.0.0.1:58111/control');
    return { ok: true, models: ['fallback'] };
  };
  const models = await client.getAIControlModels('key', 'device');
  assert.deepEqual(models.models, ['fallback']);
  assert.equal(models.transportMode, 'http');

  const signal = new AbortController().signal;
  const events = [];
  streamHandler = async (url, data, onEvent, timeout, options) => {
    onEvent({ type: 'delta' });
    events.push({ url, data, timeout, options });
    return { ok: true };
  };
  const streamed = await client.streamAIControlMessage(
    'key', 'device', 'model', [{ role: 'user', content: 'hello' }],
    { tools: [{ name: 'tool' }], runId: 'run', signal },
    (event) => events.push(event),
  );
  assert.equal(streamed.ok, true);
  assert.equal(events[0].type, 'delta');
  assert.match(events[1].url, /\/api\/ai-control\/chat\/stream$/);
  assert.equal(events[1].timeout, 240000);
  assert.equal(events[1].options.signal, signal);

  streamHandler = async () => { throw new Error('stream failed'); };
  const failed = await client.streamAIControlMessage('key', 'device', 'model', [], {});
  assert.equal(failed.ok, false);
  assert.match(failed.message, /stream failed/);
  client.runtimeServerBase = '';
  base = '';
  assert.match((await client.streamAIControlMessage('key', 'device', 'model', [])).message, /未配置/);
});
