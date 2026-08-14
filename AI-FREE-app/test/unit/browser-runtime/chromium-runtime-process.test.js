'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { stopChromiumProfile } = require('../../../src/app/main/browser-runtime/chromium-runtime-process');

test('stopping an exited Chromium does not wait for a stale close command acknowledgement', async () => {
  const messages = [];
  const state = {
    profileId: 'profile-1', status: 'ready', browserHwnd: null, hostHwnd: null,
  };
  const instance = {
    child: { exitCode: 0, pid: 123 },
    commandClient: {
      send: () => new Promise(() => {}),
      close: async () => {},
    },
    monitor: { stop() {} },
    paths: {},
  };
  const runtime = {
    instances: new Map([['profile-1', instance]]),
    logger: { info: (message) => messages.push(message) },
    store: {
      getState: () => state,
      transition: (_id, status) => { state.status = status; },
      patchState: (_id, patch) => Object.assign(state, patch),
      releaseLock() {},
    },
    unbindParentWindowFocus() {},
    windowBridge: {},
    emit() {},
    getState: () => ({ ...state }),
  };

  const result = await Promise.race([
    stopChromiumProfile(runtime, 'profile-1', { preserveSession: false }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('stop timed out')), 100)),
  ]);

  assert.equal(result.status, 'stopped');
  assert.equal(runtime.instances.size, 0);
  assert.match(messages[0], /operation=stop outcome=ok/);
  for (const phase of [
    'stateTransition', 'sessionSnapshot', 'runtimeTeardown', 'closeRequest',
    'gracefulExit', 'sessionPersist', 'transportClose', 'finalize',
  ]) {
    assert.match(messages[0], new RegExp(`${phase}Ms=`));
  }
});
