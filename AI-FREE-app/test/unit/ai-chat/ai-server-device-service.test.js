'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_HEYSURE_SERVER,
  createAiServerDeviceService,
  normalizeLoginConfig,
  normalizeToolCatalog,
} = require('../../../src/app/main/features/ai-chat/ai-server-device-service');

class FakeSocket {
  constructor() {
    this.connected = false;
    this.handlers = new Map();
    this.sent = [];
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }

  connect() {
    this.connected = true;
    this.serverEmit('connect');
  }

  disconnect() {
    this.connected = false;
  }

  emit(event, payload) {
    this.sent.push({ event, payload });
  }

  serverEmit(event, payload) {
    return this.handlers.get(event)?.(payload);
  }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function loginResponse(token = 'test-token') {
  return {
    ok: true,
    status: 200,
    json: async () => ({ access_token: token, agent_socket_url: 'http://socket.example:3000' }),
  };
}

test('AI 服务器登录默认使用 HeySure 地址且校验必填字段', () => {
  assert.equal(DEFAULT_HEYSURE_SERVER, 'http://49.234.181.190:3000');
  assert.equal(normalizeLoginConfig({ account: 'user', password: 'secret' }).server, DEFAULT_HEYSURE_SERVER);
  assert.throws(() => normalizeLoginConfig({ account: '', password: 'secret' }), /请输入账号/);
  assert.throws(() => normalizeLoginConfig({ account: 'user', password: '', server: 'ftp://invalid' }), /HTTP/);
});

test('当前 MCP 工具转换为不占用保留前缀的 aifree 工具目录', () => {
  const catalog = normalizeToolCatalog({ tools: [{
    name: 'browser_tab',
    description: '管理标签页',
    inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
  }] });
  assert.deepEqual(catalog.tools, [{
    name: 'aifree.browser_tab',
    description: '管理标签页',
    input_schema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
    destructive: false,
  }]);
  assert.equal(catalog.routes.get('aifree.browser_tab'), 'browser_tab');
});

test('登录后注册 custom 设备并将派发任务恰好回一个终态', async () => {
  const socket = new FakeSocket();
  const calls = [];
  const service = createAiServerDeviceService({
    hasVipAccess: () => true,
    fetch: async () => loginResponse(),
    createSocket: () => socket,
    computeDeviceId: async () => 'machine-123',
    getTools: () => ({ tools: [{
      name: 'browser_action', description: '执行浏览器动作',
      inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
    }] }),
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { done: true };
    },
  });

  const result = await service.login({
    server: 'http://api.example:3000', account: 'alice', password: 'secret', serviceName: '工作电脑',
  });
  assert.equal(result.ok, true);
  await tick();
  const registration = socket.sent.find((entry) => entry.event === 'device:register')?.payload;
  assert.equal(registration.id, 'ai-free-machine-123');
  assert.equal(registration.deviceType, 'custom');
  assert.equal(registration.platform, 'ai-free-custom-service');
  assert.deepEqual(registration.capabilities, ['aifree.browser_action']);
  assert.equal(registration.toolDefs[0].input_schema.required[0], 'action');

  socket.serverEmit('device:registered', { aiConfigId: 7 });
  await socket.serverEmit('task:dispatch', {
    taskId: 'task-1', tool: 'aifree.browser_action', args: { action: 'click' },
  });
  await tick();
  await socket.serverEmit('task:dispatch', {
    taskId: 'task-1', tool: 'aifree.browser_action', args: { action: 'click' },
  });
  await tick();
  assert.deepEqual(calls, [{ name: 'browser_action', args: { action: 'click' } }]);
  assert.equal(socket.sent.filter((entry) => entry.event === 'task:result').length, 1);
  assert.equal(service.status().registered, true);
  service.stop();
});

test('未知工具返回 task:error，注册拒绝后会自动重新登录', async () => {
  const socket = new FakeSocket();
  let loginCount = 0;
  const service = createAiServerDeviceService({
    hasVipAccess: () => true,
    fetch: async () => loginResponse(`token-${++loginCount}`),
    createSocket: () => socket,
    getTools: () => ({ tools: [] }),
  });
  await service.login({ account: 'alice', password: 'secret' });
  await tick();
  await socket.serverEmit('task:dispatch', { taskId: 'task-bad', tool: 'aifree.missing', args: {} });
  await tick();
  assert.match(socket.sent.find((entry) => entry.event === 'task:error').payload.error, /未知或当前不可用/);
  const taskError = socket.sent.find((entry) => entry.event === 'task:error').payload;
  assert.equal(taskError.errorCode, 'MCP_TOOL_FAILED');
  assert.equal(taskError.phase, 'heysure_task');
  assert.equal(taskError.retryable, false);

  await socket.serverEmit('device:register_rejected', { reason: 'token expired' });
  await tick();
  assert.equal(loginCount, 2);
  assert.equal(socket.sent.filter((entry) => entry.event === 'device:register').at(-1).payload.token, 'token-2');
  service.stop();
});

test('首次登录安全记忆凭据，重启后仅会员自动连接，主动断开会清除记忆', async () => {
  let saved = null;
  let clearCount = 0;
  let loginCount = 0;
  const credentialStore = {
    has: () => saved !== null,
    save: (value) => { saved = { ...value }; },
    load: () => (saved ? { ...saved } : null),
    clear: () => { saved = null; clearCount += 1; return true; },
  };
  const createService = (isVip, socket) => createAiServerDeviceService({
    hasVipAccess: () => isVip,
    credentialStore,
    fetch: async () => { loginCount += 1; return loginResponse(`token-${loginCount}`); },
    createSocket: () => socket,
    getTools: () => ({ tools: [] }),
  });

  const first = createService(true, new FakeSocket());
  assert.equal((await first.login({ account: 'alice', password: 'secret' })).ok, true);
  assert.equal(saved.account, 'alice');
  assert.equal(saved.password, 'secret');
  first.stop();
  assert.equal(clearCount, 0);

  const nonMember = createService(false, new FakeSocket());
  const skipped = await nonMember.startAutomatically();
  assert.equal(skipped.reason, 'vip_required');
  assert.equal(loginCount, 1);

  const restarted = createService(true, new FakeSocket());
  const automatic = await restarted.startAutomatically();
  assert.equal(automatic.ok, true);
  assert.equal(automatic.status.remembered, true);
  assert.equal(loginCount, 2);
  assert.equal(restarted.logout().ok, true);
  assert.equal(saved, null);
  assert.equal(clearCount, 1);
});
