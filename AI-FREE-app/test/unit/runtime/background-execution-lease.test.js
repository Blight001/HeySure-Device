'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createBackgroundExecutionLeaseManager,
} = require('../../../src/app/main/platform/background-execution-lease');

function createHarness(options = {}) {
  let nextTimerId = 1;
  const timers = new Map();
  const calls = { start: [], stop: [] };
  const blocker = {
    start(type) { calls.start.push(type); return options.blockerId ?? 7; },
    stop(id) { calls.stop.push(id); },
    isStarted: () => true,
  };
  const manager = createBackgroundExecutionLeaseManager({
    powerSaveBlocker: blocker,
    now: () => 1000,
    setTimeout: (listener, timeout) => {
      const id = nextTimerId++;
      timers.set(id, { listener, timeout });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    defaultTimeoutMs: 5000,
  });
  return { blocker, calls, manager, timers };
}

test('first lease starts one blocker and last release stops it', () => {
  const { calls, manager } = createHarness();
  const first = manager.acquire();
  const second = manager.acquire({ timeoutMs: 2000 });
  assert.deepEqual(calls.start, ['prevent-app-suspension']);
  assert.equal(manager.getSnapshot().activeLeaseCount, 2);
  assert.equal(first.release(), true);
  assert.deepEqual(calls.stop, []);
  assert.equal(second.release(), true);
  assert.deepEqual(calls.stop, [7]);
});

test('lease release is idempotent', () => {
  const { calls, manager } = createHarness();
  const lease = manager.acquire();
  assert.equal(lease.release(), true);
  assert.equal(lease.release(), false);
  assert.equal(manager.release(lease.id), false);
  assert.deepEqual(calls.stop, [7]);
});

test('lease timeout automatically releases background protection', () => {
  const { calls, manager, timers } = createHarness();
  const lease = manager.acquire({ timeoutMs: 2500 });
  assert.equal(lease.expiresAt, 3500);
  assert.equal([...timers.values()][0].timeout, 2500);
  [...timers.values()][0].listener();
  assert.equal(manager.getSnapshot().activeLeaseCount, 0);
  assert.deepEqual(calls.stop, [7]);
});

test('dispose releases all leases and prevents later acquisition', () => {
  const { calls, manager, timers } = createHarness();
  manager.acquire();
  manager.acquire();
  assert.equal(manager.dispose(), true);
  assert.equal(manager.dispose(), false);
  assert.equal(timers.size, 0);
  assert.deepEqual(calls.stop, [7]);
  assert.throws(() => manager.acquire(), { code: 'BACKGROUND_EXECUTION_LEASE_MANAGER_DISPOSED' });
});

test('failed blocker start leaves no lease behind', () => {
  const manager = createBackgroundExecutionLeaseManager({
    powerSaveBlocker: { start() { throw new Error('platform failure'); } },
  });
  assert.throws(() => manager.acquire(), { code: 'BACKGROUND_EXECUTION_BLOCKER_START_FAILED' });
  assert.equal(manager.getSnapshot().activeLeaseCount, 0);
});

test('failed timeout scheduling rolls back the blocker and lease', () => {
  const calls = [];
  const manager = createBackgroundExecutionLeaseManager({
    powerSaveBlocker: {
      start: () => 3,
      isStarted: () => true,
      stop: (id) => calls.push(id),
    },
    setTimeout() { throw new Error('timer unavailable'); },
  });
  assert.throws(() => manager.acquire(), { code: 'BACKGROUND_EXECUTION_LEASE_TIMER_FAILED' });
  assert.deepEqual(calls, [3]);
  assert.deepEqual(manager.getSnapshot(), {
    activeLeaseCount: 0, blockerActive: false, disposed: false,
  });
});
