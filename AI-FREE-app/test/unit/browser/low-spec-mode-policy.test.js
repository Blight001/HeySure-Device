'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LOW_SPEC_MODES,
  normalizeLowSpecSettings,
  resolveLowSpecMode,
} = require('../../../src/app/main/features/browser/low-spec-mode-policy');

test('low spec setting normalizes auto/on/off and rejects unknown persisted values', () => {
  assert.deepEqual(normalizeLowSpecSettings(), { mode: LOW_SPEC_MODES.AUTO });
  assert.deepEqual(normalizeLowSpecSettings(' ON '), { mode: LOW_SPEC_MODES.ON });
  assert.deepEqual(normalizeLowSpecSettings({ mode: 'off' }), { mode: LOW_SPEC_MODES.OFF });
  assert.deepEqual(normalizeLowSpecSettings({ mode: 'turbo' }), { mode: LOW_SPEC_MODES.AUTO });
});

test('auto mode enables conservative policy at 8 GB or 4 logical cores', () => {
  const memoryBound = resolveLowSpecMode({
    settings: { mode: 'auto' }, system: { totalMemoryMb: 8192, logicalCores: 8 },
  });
  const cpuBound = resolveLowSpecMode({
    settings: { mode: 'auto' }, system: { totalMemoryMb: 32768, logicalCores: 4 },
  });
  assert.equal(memoryBound.enabled, true);
  assert.equal(memoryBound.reason, 'memory');
  assert.equal(memoryBound.chromiumDisableBackgroundingOccludedWindows, false);
  assert.equal(cpuBound.enabled, true);
  assert.equal(cpuBound.reason, 'cpu');
});

test('auto mode keeps normal policy only when both capacity signals are sufficient', () => {
  const result = resolveLowSpecMode({
    settings: { mode: 'auto' }, system: { totalMemoryMb: 16384, logicalCores: 8 },
  });
  assert.equal(result.enabled, false);
  assert.equal(result.reason, 'sufficient-capacity');
  assert.equal(result.electronBackgroundThrottling, true);
  assert.equal(result.chromiumDisableBackgroundingOccludedWindows, true);
});

test('auto mode reacts to observed warning or critical resource pressure', () => {
  const system = { totalMemoryMb: 32768, logicalCores: 16, pressure: 'warning' };
  const result = resolveLowSpecMode({ settings: 'auto', system });
  assert.equal(result.enabled, true);
  assert.equal(result.reason, 'resource-pressure');
});

test('auto mode is conservative when either capacity signal is unavailable', () => {
  assert.equal(resolveLowSpecMode({ system: { logicalCores: 8 } }).enabled, true);
  assert.equal(resolveLowSpecMode({ system: { totalMemoryMb: 16384 } }).reason, 'unknown-capacity');
});

test('explicit on/off override automatic optimization without changing safe background default', () => {
  const smallDevice = { totalMemoryMb: 4096, logicalCores: 2 };
  const largeDevice = { totalMemoryMb: 32768, logicalCores: 16 };
  const forcedOff = resolveLowSpecMode({ settings: 'off', system: smallDevice });
  const forcedOn = resolveLowSpecMode({ settings: 'on', system: largeDevice });
  assert.equal(forcedOff.enabled, false);
  assert.equal(forcedOff.reason, 'user-off');
  assert.equal(forcedOff.electronBackgroundThrottling, true);
  assert.equal(forcedOn.enabled, true);
  assert.equal(forcedOn.reason, 'user-on');
});
