'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMembershipService } = require('../../../src/app/main/features/account/membership-service');
const { restoreMembership } = require('../../../src/app/main/services/app-ready-bootstrap');

function fixture(overrides = {}) {
  const writes = [];
  const events = [];
  const timers = [];
  const runtime = { tutorialUrl: 'https://old.example/tutorial' };
  const credentials = {
    authType: 'account',
    username: 'alice',
    sessionToken: 'afs_license-key',
    deviceId: 'trusted-device',
    serverBase: 'https://service.example',
    serverMode: 'remote',
    platformName: 'default',
    account: { is_vip: true, vip_active: true, vip_server_verified: true },
    validation: { is_vip: true, vip_active: true, vip_server_verified: true },
  };
  const context = {
    readStoreConfigSafe: () => writes.at(-1) || { userCredentials: credentials },
    writeStoreConfigSafe: (value) => { writes.push(value); return true; },
    getGlobalHttpClient: () => ({
      runtimeServerBase: '',
      validateSession: async () => ({
        valid: true,
        is_vip: true,
        vip_active: true,
        vip_tier: 'vip',
        tutorial_url: 'https://new.example/tutorial',
      }),
    }),
    licenseCache: {
      getRuntimeConfig: () => runtime,
      setCredentials(value) { this.credentials = value; },
      setValidationState(value) { this.validation = value; },
      setRuntimeConfig(value) { Object.assign(runtime, value); },
    },
    applyResolvedConfigToStore: (value) => events.push(['resolved', value]),
    refreshAllowedPlatformsAndNotify: () => events.push(['platforms']),
    sendToSide: (channel, value) => events.push([channel, value]),
    setIntervalFn: (callback, interval) => {
      const timer = { callback, interval, unrefCalled: false, unref() { this.unrefCalled = true; } };
      timers.push(timer);
      return timer;
    },
    logger: { log() {}, warn() {} },
    ...overrides,
  };
  return { context, credentials, events, runtime, timers, writes };
}

test('启动恢复先在线验证会员、持久化服务端状态并安排五分钟刷新', async () => {
  const data = fixture();
  const result = await createMembershipService(data.context).restore();
  assert.equal(result.restored, true);
  assert.equal(data.writes.length, 1);
  assert.equal(data.writes[0].userCredentials.validation.vip_server_verified, true);
  assert.deepEqual(data.context.licenseCache.credentials, { key: 'afs_license-key', deviceId: 'trusted-device' });
  assert.equal(data.timers[0].interval, 5 * 60 * 1000);
  assert.equal(data.timers[0].unrefCalled, true);
});

test('启动恢复会先创建全局 HTTP 客户端，避免把有效 VIP 误判为服务不可用', async () => {
  const data = fixture();
  const calls = [];
  let client = null;
  data.context.getGlobalHttpClient = () => client;
  data.context.createHttpClient = (options) => {
    calls.push(['create', options]);
    return {
      runtimeServerBase: '',
      validateSession: async () => ({ valid: true, is_vip: true, vip_active: true, vip_tier: 'svip' }),
    };
  };
  data.context.setGlobalHttpClient = (value) => {
    calls.push(['set', value]);
    client = value;
  };

  const result = await restoreMembership(data.context);

  assert.equal(result.state.verified, true);
  assert.equal(data.writes[0].userCredentials.validation.is_vip, true);
  assert.deepEqual(calls[0], ['create', { mainWindow: null }]);
  assert.equal(calls[1][0], 'set');
});

test('在线验证失败时关闭本地 VIP，周期刷新向渲染层发布安全降级状态', async () => {
  const data = fixture({
    getGlobalHttpClient: () => ({ runtimeServerBase: '', validateSession: async () => ({ valid: false, message: 'offline' }) }),
  });
  const result = await createMembershipService(data.context).refresh(data.credentials, 'periodic');
  assert.equal(result.verified, false);
  assert.equal(result.validation.vip_server_verified, false);
  assert.equal(result.validation.is_vip, false);
  assert.equal(data.events.some(([channel]) => channel === 'account-session-updated'), true);
});

test('并发会员刷新复用同一个服务器请求并在完成后允许重试', async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const data = fixture({
    getGlobalHttpClient: () => ({
      runtimeServerBase: '',
      validateSession: async () => { calls += 1; await pending; return { valid: true, is_vip: true }; },
    }),
  });
  const service = createMembershipService(data.context);
  const first = service.refresh(data.credentials, 'startup');
  const second = service.refresh(data.credentials, 'periodic');
  assert.equal(calls, 1);
  release();
  assert.equal(await first, await second);
  await service.refresh(data.credentials, 'periodic');
  assert.equal(calls, 2);
});
