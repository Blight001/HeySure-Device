// 单元测试：ipc/registry.js 注册器行为（真实调用，无源码文本断言）。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.join(__dirname, '..', '..', '..');
const { createIpcRegistry } = require(path.join(root, 'src', 'app', 'main', 'ipc', 'registry.js'));
const contracts = require(path.join(root, 'src', 'app', 'contracts', 'ipc-channels.js'));

const KNOWN_INVOKE = contracts.INVOKE_CHANNELS[0].channel;
const KNOWN_EVENT = contracts.EVENT_CHANNELS[0].channel;

function fakeIpcMain() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handlers,
    listeners,
    handle: (ch, fn) => handlers.set(ch, fn),
    removeHandler: (ch) => handlers.delete(ch),
    on: (ch, fn) => listeners.set(ch, fn),
    removeListener: (ch, fn) => {
      if (listeners.get(ch) === fn) listeners.delete(ch);
    },
  };
}

test('已登记通道可注册，实际落到 ipcMain', () => {
  const ipcMain = fakeIpcMain();
  const registry = createIpcRegistry(ipcMain, { source: 'unit' });
  registry.handle(KNOWN_INVOKE, async () => 'ok');
  registry.on(KNOWN_EVENT, () => {});
  assert.equal(ipcMain.handlers.size, 1);
  assert.equal(ipcMain.listeners.size, 1);
  assert.deepEqual(registry.stats(), { source: 'unit', handles: 1, listeners: 1, disposed: false });
});

test('未登记通道注册立即抛错', () => {
  const registry = createIpcRegistry(fakeIpcMain(), { source: 'unit' });
  assert.throws(() => registry.handle('no-such-channel-xyz', async () => {}), /未在 contracts/);
  assert.throws(() => registry.on('no-such-channel-xyz', () => {}), /未在 contracts/);
});

test('同一实例内重复注册抛错并指出已注册来源', () => {
  const registry = createIpcRegistry(fakeIpcMain(), { source: 'unit' });
  const scoped = registry.scope('module-a');
  scoped.handle(KNOWN_INVOKE, async () => {});
  assert.throws(
    () => registry.scope('module-b').handle(KNOWN_INVOKE, async () => {}),
    new RegExp(`'${KNOWN_INVOKE}' 重复注册：已由 module-a`),
  );
});

test('dispose 释放全部注册且不可再用；新实例可重新注册同通道', () => {
  const ipcMain = fakeIpcMain();
  const first = createIpcRegistry(ipcMain, { source: 'r1' });
  first.handle(KNOWN_INVOKE, async () => {});
  first.on(KNOWN_EVENT, () => {});
  first.dispose();
  assert.equal(ipcMain.handlers.size, 0);
  assert.equal(ipcMain.listeners.size, 0);
  assert.throws(() => first.handle(KNOWN_INVOKE, async () => {}), /dispose/);

  const second = createIpcRegistry(ipcMain, { source: 'r2' });
  second.handle(KNOWN_INVOKE, async () => {});
  assert.equal(ipcMain.handlers.size, 1);
});

test('dispose 只移除自己的监听器（按引用精确移除）', () => {
  const ipcMain = fakeIpcMain();
  const registry = createIpcRegistry(ipcMain, { source: 'unit' });
  registry.on(KNOWN_EVENT, () => {});
  const foreign = () => {};
  ipcMain.on('foreign-dynamic-channel', foreign);
  registry.dispose();
  assert.equal(ipcMain.listeners.has('foreign-dynamic-channel'), true, '不得误删非注册器管理的监听');
});

test('声明 requestSchema 的 invoke 在进入业务 handler 前自动校验', async () => {
  const ipcMain = fakeIpcMain();
  const registry = createIpcRegistry(ipcMain, { source: 'unit' });
  let called = 0;
  registry.handle('ai-control-chat-stop', async (_event, payload) => {
    called += 1;
    return { ok: true, requestId: payload.requestId };
  });

  const handler = ipcMain.handlers.get('ai-control-chat-stop');
  assert.deepEqual(await handler({}, { requestId: 'req-1' }), { ok: true, requestId: 'req-1' });
  assert.equal(called, 1);
  assert.deepEqual(await handler({}, { requestId: 42 }), {
    ok: false,
    code: 'IPC_INVALID_PAYLOAD',
    message: '请求参数无效：requestId 必须是字符串',
  });
  assert.equal(called, 1, '非法输入不得触发业务 handler');
});
