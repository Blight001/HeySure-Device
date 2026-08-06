'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createAiModelService, createCustomModel, remoteUnavailable } = require('../../../src/app/main/features/ai-chat/ai-model-service');

const verifiedVip = {
  vip_server_verified: true,
  vip_verified_at: new Date().toISOString(),
  is_vip: true,
};
const customStore = {
  aiControlSettings: { customApi: { enabled: true, name: 'Private', baseUrl: 'https://api.example.test', model: 'fixture-model' } },
};

test('custom model requires both verified VIP access and complete configuration', () => {
  const vipCache = { getSnapshot: () => verifiedVip };
  assert.deepEqual(createCustomModel(customStore, vipCache), {
    id: '__custom_openai_api__', name: 'Private', model: 'fixture-model', custom_api: true,
    supports_image_input: false,
  });
  assert.equal(createCustomModel(customStore, { getSnapshot: () => ({}) }), null);
  assert.equal(createCustomModel({ aiControlSettings: { customApi: { enabled: true } } }, vipCache), null);
  assert.equal(createCustomModel({}, null), null);
});

test('remote unavailable response preserves an available custom model', () => {
  const model = { id: 'custom' };
  assert.deepEqual(remoteUnavailable(model), { ok: true, models: [model], quota: null, remoteError: 'AI 服务尚未就绪' });
  assert.deepEqual(remoteUnavailable(null, 'offline'), { ok: false, message: 'offline' });
});

test('model service handles missing credentials and unavailable clients', async () => {
  const service = createAiModelService({
    readStoreConfigSafe: () => customStore,
    licenseCache: { getSnapshot: () => verifiedVip },
    getGlobalHttpClient: () => null,
  });
  const local = await service.getModels();
  assert.equal(local.ok, true);
  assert.equal(local.models[0].custom_api, true);

  const plain = createAiModelService({ readStoreConfigSafe: () => ({}), getGlobalHttpClient: () => ({}) });
  assert.deepEqual(await plain.getModels(), { ok: false, message: 'AI 服务尚未就绪' });
});

test('model service merges remote models and degrades remote errors to custom-only', async () => {
  const store = { ...customStore, userCredentials: { sessionToken: 'license', deviceId: 'device' } };
  let response = { ok: true, models: [{ id: 'remote' }], quota: 8 };
  const calls = [];
  const service = createAiModelService({
    readStoreConfigSafe: () => store,
    licenseCache: { getSnapshot: () => verifiedVip },
    getGlobalHttpClient: () => ({ getAIControlModels: async (...args) => { calls.push(args); return response; } }),
  });
  const merged = await service.getModels();
  assert.deepEqual(merged.models.map((model) => model.id), ['remote', '__custom_openai_api__']);
  assert.deepEqual(calls, [['license', 'device']]);
  response = { ok: false, error: 'gateway down' };
  const degraded = await service.getModels();
  assert.equal(degraded.ok, true);
  assert.equal(degraded.remoteError, 'gateway down');

  const noCustom = createAiModelService({
    readStoreConfigSafe: () => ({ userCredentials: { sessionToken: 'k', deviceId: 'd' } }),
    getGlobalHttpClient: () => ({ getAIControlModels: async () => ({ ok: false, message: 'denied' }) }),
  });
  assert.deepEqual(await noCustom.getModels(), { ok: false, message: 'denied' });
});
