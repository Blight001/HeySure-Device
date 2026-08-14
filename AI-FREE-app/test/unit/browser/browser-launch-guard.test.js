'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  BROWSER_LAUNCH_CODES,
  createBrowserLaunchGuard,
  evaluateBrowserLaunch,
} = require('../../../src/app/main/features/browser/browser-launch-guard');

function snapshot(overrides = {}) {
  return {
    status: 'available',
    pressure: 'normal',
    totalMemoryMb: 8192,
    availableMemoryMb: 2048,
    freeDiskMb: 4096,
    activeProfiles: 0,
    ...overrides,
  };
}

test('returns stable denial codes for unavailable and incomplete snapshots', () => {
  assert.equal(evaluateBrowserLaunch(snapshot({ status: 'unavailable' })).code,
    BROWSER_LAUNCH_CODES.snapshotUnavailable);
  assert.equal(evaluateBrowserLaunch(snapshot({ status: 'partial', freeDiskMb: null })).code,
    BROWSER_LAUNCH_CODES.snapshotPartial);
});

test('disk and critical memory are hard admission gates', () => {
  const disk = evaluateBrowserLaunch(snapshot({ freeDiskMb: 2047 }));
  assert.deepEqual([disk.ok, disk.code, disk.retryable], [false, BROWSER_LAUNCH_CODES.diskCritical, true]);
  const memory = evaluateBrowserLaunch(snapshot({ pressure: 'critical', availableMemoryMb: 700 }));
  assert.deepEqual([memory.ok, memory.code, memory.retryable], [false, BROWSER_LAUNCH_CODES.memoryCritical, true]);
});

test('warning memory permits only the first profile', () => {
  const first = evaluateBrowserLaunch(snapshot({ pressure: 'warning', availableMemoryMb: 1000 }));
  assert.equal(first.ok, true);
  assert.equal(first.code, BROWSER_LAUNCH_CODES.allowedWithWarning);
  assert.equal(first.warningCode, BROWSER_LAUNCH_CODES.memoryWarningCapacity);

  const second = evaluateBrowserLaunch(snapshot({
    pressure: 'warning',
    availableMemoryMb: 1000,
    activeProfiles: 1,
  }));
  assert.equal(second.ok, false);
  assert.equal(second.code, BROWSER_LAUNCH_CODES.memoryWarningCapacity);
});

test('capacity denial includes only redacted diagnostic fields', () => {
  const result = evaluateBrowserLaunch(snapshot({ activeProfiles: 2, privatePath: 'secret' }));
  assert.equal(BROWSER_LAUNCH_CODES.capacityReached, 'BROWSER_DEVICE_CAPACITY_REACHED');
  assert.equal(result.code, BROWSER_LAUNCH_CODES.capacityReached);
  assert.equal(result.retryable, false);
  assert.deepEqual(Object.keys(result.snapshot), [
    'status', 'pressure', 'totalMemoryMb', 'availableMemoryMb', 'freeDiskMb', 'logicalCores',
    'activeProfiles', 'profileLimit',
  ]);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test('partial non-critical telemetry allows launch with an explicit warning', () => {
  const result = evaluateBrowserLaunch(snapshot({ status: 'partial' }));
  assert.equal(result.ok, true);
  assert.equal(result.code, BROWSER_LAUNCH_CODES.allowedWithWarning);
  assert.equal(result.warningCode, BROWSER_LAUNCH_CODES.snapshotPartial);
});

test('guard forces a current snapshot and forwards entitlement limits', async () => {
  const calls = [];
  const guard = createBrowserLaunchGuard({
    resourceMonitor: {
      getSnapshot: async (options) => { calls.push(options); return snapshot({ totalMemoryMb: 32768 }); },
    },
  });
  const result = await guard.evaluate({ productLimit: 2, administratorLimit: 7 });

  assert.deepEqual(calls, [{ force: true, maxAgeMs: 2000 }]);
  assert.equal(result.ok, true);
  assert.equal(result.capacity.profileLimit, 2);
});

test('guard validates its monitor dependency and supports policy injection', async () => {
  assert.throws(() => createBrowserLaunchGuard(), /resourceMonitor/);
  const expected = Object.freeze({ ok: false, code: 'CUSTOM' });
  const guard = createBrowserLaunchGuard({
    resourceMonitor: { getSnapshot: async () => snapshot() },
    capacityPolicy: () => expected,
  });
  assert.equal(await guard.evaluate(), expected);
});
