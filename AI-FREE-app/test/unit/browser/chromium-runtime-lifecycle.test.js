'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { ChromiumRuntime } = require('../../../src/app/main/browser-runtime/chromium-runtime');
const { createChromiumLaunchDiagnostics } = require('../../../src/app/main/browser-runtime/chromium-process-diagnostics');
const { RUNTIME_STATUS } = require('../../../src/app/main/browser-runtime/runtime-types');

function createRuntime(status = RUNTIME_STATUS.WAITING_PIPE) {
  const state = { profileId: 'slow-profile', status };
  const store = {
    getState: () => state,
    patchState: (_id, patch) => Object.assign(state, patch),
    transition: (_id, next) => { state.status = next; },
  };
  const runtime = new ChromiumRuntime({ store, logger: { warn() {} } });
  const child = new EventEmitter();
  child.exitCode = null;
  child.pid = 1234;
  const commandClient = new EventEmitter();
  commandClient.lastHello = null;
  const instance = { child, commandClient, profile: { launchTimeoutMs: 3000 } };
  runtime.instances.set('slow-profile', instance);
  return { instance, runtime, state };
}

test('停止中的 Profile 会立即取消尚在等待的 Chromium 握手', async () => {
  const { instance, runtime, state } = createRuntime();
  state.status = RUNTIME_STATUS.STOPPING;

  await assert.rejects(
    runtime.waitForBrowserWindow('slow-profile', instance),
    (error) => error.code === 'CHROMIUM_LAUNCH_CANCELLED',
  );
});

test('迟到的握手不能把 stopping Profile 重新切换到 attaching', async () => {
  const { instance, runtime, state } = createRuntime(RUNTIME_STATUS.STOPPING);

  await assert.rejects(
    runtime.attachProfileWindow('slow-profile', instance, '4321', {}),
    (error) => error.code === 'CHROMIUM_LAUNCH_CANCELLED',
  );
  assert.equal(state.status, RUNTIME_STATUS.STOPPING);
});

test('仍有存活 Chromium 进程时拒绝覆盖同一 Profile 实例', () => {
  const { runtime } = createRuntime();

  assert.throws(
    () => runtime.prepareProfileLaunch('slow-profile', { profileId: 'slow-profile' }, {}),
    (error) => error.code === 'CHROMIUM_PROFILE_ALREADY_RUNNING',
  );
});

test('Chromium 握手前退出时保留真实退出码和内核诊断', async () => {
  const { instance, runtime } = createRuntime();
  const diagnostics = createChromiumLaunchDiagnostics();
  diagnostics.record('stderr', 'missing dependency');
  instance.diagnostics = diagnostics;
  runtime.bindInstance('slow-profile', instance);

  instance.child.exitCode = -1073741515;
  instance.child.emit('exit', -1073741515, null);

  await assert.rejects(
    runtime.waitForBrowserWindow('slow-profile', instance),
    (error) => error.code === 'CHROMIUM_PROCESS_EXITED'
      && error.message.includes('0xC0000135')
      && error.message.includes('VC++ 运行库')
      && error.message.includes('missing dependency'),
  );
});
