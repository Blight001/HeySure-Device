'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAiSettingsService } = require('../../../src/app/main/features/ai-chat/ai-settings-service');

function vipSnapshot() {
  return { is_vip: true, vip_active: true, vip_server_verified: true, vip_verified_at: new Date().toISOString() };
}

function fixture(overrides = {}) {
  const writes = [];
  const initial = {
    unrelated: { keep: true },
    aiControlSettings: {
      mcpCallLimit: 50,
      customApi: { enabled: true, name: 'Old', baseUrl: 'https://old.example/v1', model: 'old', apiKey: 'secret' },
    },
  };
  const context = {
    readStore: () => writes.at(-1) || initial,
    writeStore: (value) => { writes.push(value); return true; },
    licenseCache: { getSnapshot: () => vipSnapshot() },
    ...overrides,
  };
  return { context, writes };
}

test('MCP 上限按安全范围归一化且保留其它配置', () => {
  const data = fixture();
  const result = createAiSettingsService(data.context).setSettings({ mcpCallLimit: 999999 });
  assert.equal(result.ok, true);
  assert.equal(result.settings.mcpCallLimit, 1000);
  assert.deepEqual(data.writes[0].unrelated, { keep: true });
  assert.equal(data.writes[0].aiControlSettings.customApi.apiKey, 'secret');
  assert.throws(() => createAiSettingsService(data.context).setSettings({ mcpCallLimit: 'invalid' }), /有效数字/);
});

test('自定义 API 要求在线验证 VIP，公开结果不泄露 API Key', () => {
  const nonVip = fixture({ licenseCache: { getSnapshot: () => ({}) } });
  const denied = createAiSettingsService(nonVip.context).setCustomApi({ baseUrl: 'https://api.example', model: 'm' });
  assert.equal(denied.code, 'VIP_REQUIRED');
  assert.equal(nonVip.writes.length, 0);
  const data = fixture();
  const result = createAiSettingsService(data.context).setCustomApi({
    name: 'New', baseUrl: 'https://api.example/v1', model: 'next-model',
  });
  assert.equal(result.ok, true);
  assert.equal(data.writes[0].aiControlSettings.customApi.apiKey, 'secret');
  assert.equal(Object.prototype.hasOwnProperty.call(result.config, 'apiKey'), false);
  assert.equal(result.config.hasApiKey, true);
});

test('无效地址和写入失败返回明确错误，清除配置不要求 VIP', () => {
  const data = fixture();
  const service = createAiSettingsService(data.context);
  assert.throws(() => service.setCustomApi({ baseUrl: 'ftp://api.example', model: 'm' }), /http/);
  const failed = fixture({ writeStore: () => false });
  assert.throws(() => createAiSettingsService(failed.context).setSettings({ mcpCallLimit: 10 }), /未能写入/);
  const nonVip = fixture({ licenseCache: { getSnapshot: () => ({}) } });
  assert.equal(createAiSettingsService(nonVip.context).setCustomApi({ clear: true }).ok, true);
});
