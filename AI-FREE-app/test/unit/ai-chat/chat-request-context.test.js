'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createChatEmitter,
  createIdentityRecovery,
  normalizeChatOptions,
  resolveChatAccess,
  resolveConnections,
  validateQuota,
} = require('../../../src/app/main/features/ai-chat/chat-request-context');

test('额度边界和旧多选输入被归一化为单一控制浏览器', () => {
  assert.equal(validateQuota({ unlimited: true, remaining: 0 }), null);
  assert.equal(validateQuota({ quota: 10, used: 10 }).ok, false);
  assert.equal(validateQuota({ quota: 10, remaining: 1 }), null);
  assert.deepEqual(
    normalizeChatOptions({ browserConnectionIds: [' a ', 'a', '', 'b'], stream: true, requestId: ' r ' }).connectionIds,
    ['a'],
  );
});

test('内置模型要求登录和服务可用，自定义模型同时要求 VIP 与完整配置', () => {
  const base = { readStoreConfigSafe: () => ({}), getGlobalHttpClient: () => null, licenseCache: { getSnapshot: () => ({}) } };
  assert.match(resolveChatAccess(base, { modelId: 'builtin' }).error.message, /登录/);
  const signedIn = {
    ...base,
    readStoreConfigSafe: () => ({ userCredentials: { sessionToken: 'afs_session', deviceId: 'device' } }),
    getGlobalHttpClient: () => ({ sendAIControlMessage() {} }),
  };
  assert.equal(resolveChatAccess(signedIn, { modelId: 'builtin' }).key, 'afs_session');
  assert.equal(resolveChatAccess(base, { modelId: '__custom_openai_api__' }).error.code, 'VIP_REQUIRED');
  const vip = { ...base, licenseCache: { getSnapshot: () => ({ is_vip: true, vip_active: true, vip_server_verified: true, vip_verified_at: new Date().toISOString() }) } };
  assert.match(resolveChatAccess(vip, { modelId: '__custom_openai_api__' }).error.message, /尚未配置完整/);
});

test('浏览器连接离线立即失败，正常连接保留插件元数据', () => {
  const options = { disableTools: false, connectionIds: ['one'] };
  const missing = resolveConnections({ browserAutomationBridge: { listConnections: () => [] } }, options);
  assert.match(missing.error.message, /离线/);
  const connection = { id: 'one', name: 'Browser' };
  const found = resolveConnections({
    browserAutomationBridge: { listConnections: () => [connection], getConnection: () => connection },
    getTabs: () => [],
    browserRuntimeManager: { listStates: () => [] },
  }, options);
  assert.equal(found.connections[0].id, 'one');
  assert.equal(found.controlledConnectionId, 'one');
});

test('流式事件仅发送到仍存活的原请求窗口', () => {
  const sent = [];
  const sender = { destroyed: false, isDestroyed() { return this.destroyed; }, send: (...args) => sent.push(args) };
  const emit = createChatEmitter({ sender }, { useStream: true, requestId: 'request-1' });
  emit({ type: 'done' });
  sender.destroyed = true;
  emit({ type: 'late' });
  assert.deepEqual(sent, [['ai-control-chat-event', { requestId: 'request-1', type: 'done' }]]);
});

test('设备登录恢复器只在认证成功后返回最新持久化凭据', async () => {
  let current = { sessionToken: 'old', deviceId: 'device' };
  const recovery = createIdentityRecovery({
    accountService: {
      authenticate: async () => {
        current = { sessionToken: 'new', deviceId: 'device' };
        return { ok: true };
      },
    },
    readStoreConfigSafe: () => ({ userCredentials: current }),
  });
  assert.deepEqual(await recovery(), { key: 'new', deviceId: 'device' });
  assert.equal(createIdentityRecovery({}), null);
});
