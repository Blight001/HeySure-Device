// 单元测试：runtime/app-context.js——业务性 global.* 的替代容器。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.join(__dirname, '..', '..', '..');
const { createAppContext, appContext } = require(path.join(root, 'src', 'app', 'main', 'runtime', 'app-context.js'));

test('退出标志：初始为 false，标记后为 true', () => {
  const ctx = createAppContext();
  assert.equal(ctx.isShuttingDown(), false);
  ctx.markShuttingDown();
  assert.equal(ctx.isShuttingDown(), true);
});

test('beginMainAppExit 首次返回 true，重入返回 false（before-quit 重入保护）', () => {
  const ctx = createAppContext();
  assert.equal(ctx.beginMainAppExit(), true);
  assert.equal(ctx.beginMainAppExit(), false);
  assert.equal(ctx.beginMainAppExit(), false);
});

test('更新挂起状态：set/get/clear，get 返回 trim 后副本', () => {
  const ctx = createAppContext();
  assert.deepEqual(ctx.getPendingUpdateInstall(), { version: '', target: '' });
  ctx.setPendingUpdateInstall({ version: ' 2.6.8 ', target: ' C:/x/update.exe ' });
  assert.deepEqual(ctx.getPendingUpdateInstall(), { version: '2.6.8', target: 'C:/x/update.exe' });
  ctx.clearPendingUpdateInstall();
  assert.deepEqual(ctx.getPendingUpdateInstall(), { version: '', target: '' });
});

test('sessionId 每个上下文唯一且稳定', () => {
  const a = createAppContext();
  const b = createAppContext();
  assert.ok(a.getSessionId());
  assert.equal(a.getSessionId(), a.getSessionId());
  assert.notEqual(a.getSessionId(), b.getSessionId());
});

test('调试控制台写入钩子：仅接受函数，可覆盖', () => {
  const ctx = createAppContext();
  assert.equal(ctx.getDebugConsoleWrite(), null);
  const fn = () => {};
  ctx.setDebugConsoleWrite(fn);
  assert.equal(ctx.getDebugConsoleWrite(), fn);
  ctx.setDebugConsoleWrite('not-a-function');
  assert.equal(ctx.getDebugConsoleWrite(), null);
});

test('默认单例存在且与 createAppContext 行为一致', () => {
  assert.equal(typeof appContext.isShuttingDown, 'function');
  assert.equal(typeof appContext.getSessionId, 'function');
});
