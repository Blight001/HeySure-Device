'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createSystemResourceMonitor,
  deepFreeze,
} = require('../../../src/app/main/platform/system-resource-monitor');

const MB = 1024 * 1024;

function fixture(overrides = {}) {
  let now = 0;
  let freeMemoryMb = 2048;
  const monitor = createSystemResourceMonitor({
    os: {
      totalmem: () => 8 * 1024 * MB,
      freemem: () => freeMemoryMb * MB,
      cpus: () => [{}, {}, {}, {}],
    },
    fs: { statfsSync: () => ({ bavail: 4096, bsize: MB }) },
    profileRoot: 'private-profile-root',
    getMainProcessMemoryBytes: () => 256 * MB,
    getActiveProfiles: () => [{ pid: 123, profilePath: 'private-path' }],
    getLowSpecMode: () => 'auto',
    getOnBatteryPower: () => false,
    now: () => now,
    ...overrides,
  });
  return {
    monitor,
    setFreeMemoryMb: (value) => { freeMemoryMb = value; },
    setNow: (value) => { now = value; },
  };
}

test('publishes an immutable, redacted available snapshot', async () => {
  const { monitor } = fixture();
  const snapshot = await monitor.sample();

  assert.deepEqual(snapshot, {
    status: 'available',
    capturedAt: 0,
    pressure: 'normal',
    totalMemoryMb: 8192,
    availableMemoryMb: 2048,
    mainProcessWorkingSetMb: 256,
    activeProfiles: 1,
    freeDiskMb: 4096,
    logicalCores: 4,
    lowSpecMode: 'auto',
    onBatteryPower: false,
    unavailableMetrics: [],
  });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.unavailableMetrics), true);
  assert.doesNotMatch(JSON.stringify(snapshot), /private|123/);
});

test('marks collection failures partial and never substitutes unknown values with zero', async () => {
  const { monitor } = fixture({
    getMainProcessMemoryBytes: () => { throw new Error('denied'); },
    fs: { statfsSync: () => { throw new Error('unmounted'); } },
  });
  const snapshot = await monitor.sample();

  assert.equal(snapshot.status, 'partial');
  assert.equal(snapshot.mainProcessWorkingSetMb, null);
  assert.equal(snapshot.freeDiskMb, null);
  assert.deepEqual(snapshot.unavailableMetrics, ['mainProcessWorkingSet', 'freeDisk']);
});

test('reports unavailable when every required collection fails', async () => {
  const throwing = () => { throw new Error('unavailable'); };
  const monitor = createSystemResourceMonitor({
    os: { totalmem: throwing, freemem: throwing, cpus: throwing },
    fs: { statfsSync: throwing },
    profileRoot: 'profile-root',
    getMainProcessMemoryBytes: throwing,
    getActiveProfiles: throwing,
    now: () => 10,
  });
  const snapshot = await monitor.sample();

  assert.equal(snapshot.status, 'unavailable');
  assert.equal(snapshot.pressure, 'warning');
  assert.equal(snapshot.availableMemoryMb, null);
});

test('applies critical and warning recovery hysteresis', async () => {
  const state = fixture();
  state.setFreeMemoryMb(700);
  assert.equal((await state.monitor.sample()).pressure, 'critical');

  state.setFreeMemoryMb(2000);
  state.setNow(1_000);
  assert.equal((await state.monitor.sample()).pressure, 'critical');
  state.setNow(15_999);
  assert.equal((await state.monitor.sample()).pressure, 'critical');
  state.setNow(16_000);
  assert.equal((await state.monitor.sample()).pressure, 'warning');
  state.setNow(45_999);
  assert.equal((await state.monitor.sample()).pressure, 'warning');
  state.setNow(46_000);
  assert.equal((await state.monitor.sample()).pressure, 'normal');
});

test('resets recovery windows when memory falls below the recovery threshold', async () => {
  const state = fixture();
  state.setFreeMemoryMb(700);
  await state.monitor.sample();
  state.setFreeMemoryMb(1100);
  state.setNow(1_000);
  await state.monitor.sample();
  state.setFreeMemoryMb(900);
  state.setNow(10_000);
  await state.monitor.sample();
  state.setFreeMemoryMb(1100);
  state.setNow(20_000);
  assert.equal((await state.monitor.sample()).pressure, 'critical');
  state.setNow(35_000);
  assert.equal((await state.monitor.sample()).pressure, 'warning');
});

test('reuses fresh snapshots and manages one periodic timer', async () => {
  let samples = 0;
  let callback;
  let cleared = null;
  const fakeTimer = { unref() {} };
  const state = fixture({
    getActiveProfiles: () => { samples += 1; return 0; },
    setInterval: (handler, milliseconds) => { callback = [handler, milliseconds]; return fakeTimer; },
    clearInterval: (timer) => { cleared = timer; },
  });
  await state.monitor.sample();
  await state.monitor.getSnapshot();
  assert.equal(samples, 1);
  state.monitor.start();
  state.monitor.start();
  await new Promise(setImmediate);
  assert.equal(callback[1], 5000);
  callback[0]();
  await new Promise(setImmediate);
  assert.equal(samples, 3);
  state.monitor.stop();
  assert.equal(cleared, fakeTimer);
});

test('background sampling absorbs unexpected failures with a redacted message', async () => {
  const warnings = [];
  let timerCallback;
  const state = fixture({
    now: () => { throw new Error('secret profile path'); },
    logger: { warn: (message) => warnings.push(message) },
    setInterval: (callback) => { timerCallback = callback; return { unref() {} }; },
  });
  state.monitor.start();
  await new Promise(setImmediate);
  timerCallback();
  await new Promise(setImmediate);

  assert.deepEqual(warnings, [
    '[SystemResourceMonitor] resource sample failed',
    '[SystemResourceMonitor] resource sample failed',
  ]);
  assert.doesNotMatch(warnings.join(' '), /secret/);
});

test('normalizes supported profile collections and optional metric values', async () => {
  for (const [profiles, expected] of [
    [new Map([['one', {}]]), 1],
    [new Set(['one', 'two']), 2],
    [3, 3],
  ]) {
    const { monitor } = fixture({
      getActiveProfiles: () => profiles,
      getLowSpecMode: () => true,
      getOnBatteryPower: () => 'unknown',
    });
    const result = await monitor.sample();
    assert.equal(result.activeProfiles, expected);
    assert.equal(result.lowSpecMode, null);
    assert.equal(result.onBatteryPower, null);
  }
});

test('supports custom thresholds, forced refresh and safe repeated stop', async () => {
  let samples = 0;
  const { monitor } = fixture({
    thresholds: { memoryWarningMb: 2500 },
    getActiveProfiles: () => { samples += 1; return 0; },
  });
  assert.equal((await monitor.getSnapshot()).pressure, 'warning');
  await monitor.getSnapshot({ force: true });
  assert.equal(samples, 2);
  monitor.stop();
  monitor.stop();
});

test('missing disk root remains unknown and deepFreeze handles repeated and primitive values', async () => {
  const { monitor } = fixture({ profileRoot: '' });
  const result = await monitor.sample();
  assert.equal(result.status, 'partial');
  assert.equal(result.freeDiskMb, null);
  assert.equal(deepFreeze(null), null);
  assert.equal(deepFreeze(result), result);
});

test('default Node collectors provide a usable redacted snapshot', async () => {
  const monitor = createSystemResourceMonitor({ profileRoot: process.cwd() });
  const result = await monitor.sample();
  assert.equal(result.status, 'available');
  assert.equal(result.activeProfiles, 0);
  assert.equal(result.lowSpecMode, 'auto');
  assert.equal(result.onBatteryPower, null);
  assert.equal(result.totalMemoryMb > 0, true);
});

test('timer and logger adapters may omit optional methods', async () => {
  const state = fixture({
    now: () => { throw new Error('failure'); },
    logger: {},
    setInterval: () => 42,
    clearInterval() {},
  });
  state.monitor.start();
  await new Promise(setImmediate);
  state.monitor.stop();
});

test('coalesces concurrent samples to avoid overlapping platform collectors', async () => {
  let release;
  let calls = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const state = fixture({
    getActiveProfiles: async () => { calls += 1; await pending; return 2; },
  });
  const first = state.monitor.sample();
  const second = state.monitor.sample();
  release();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(one, two);
});
