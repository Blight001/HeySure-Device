'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  calculateBrowserCapacity,
  deviceLimitForMemory,
} = require('../../../src/app/main/features/browser/browser-capacity-policy');

test('maps physical memory tiers to conservative device limits', () => {
  assert.equal(deviceLimitForMemory(null), 1);
  assert.equal(deviceLimitForMemory(4096), 1);
  assert.equal(deviceLimitForMemory(4097), 2);
  assert.equal(deviceLimitForMemory(8192), 2);
  assert.equal(deviceLimitForMemory(8193), 3);
  assert.equal(deviceLimitForMemory(16384), 3);
  assert.equal(deviceLimitForMemory(16385), 5);
});

test('takes the minimum of product, device, administrator and safety limits', () => {
  const capacity = calculateBrowserCapacity(
    { totalMemoryMb: 32768, activeProfiles: 2 },
    { productLimit: 99, administratorLimit: 4, globalSafetyLimit: 8 },
  );
  assert.deepEqual(capacity, {
    productLimit: 99,
    deviceLimit: 5,
    administratorLimit: 4,
    globalSafetyLimit: 8,
    profileLimit: 4,
    activeProfiles: 2,
    remaining: 2,
    atCapacity: false,
  });
  assert.equal(Object.isFrozen(capacity), true);
});

test('VIP product limits cannot bypass device or global safety capacity', () => {
  assert.equal(calculateBrowserCapacity(
    { totalMemoryMb: 4096, activeProfiles: 1 },
    { productLimit: 100, administratorLimit: 100, globalSafetyLimit: 8 },
  ).profileLimit, 1);
  assert.equal(calculateBrowserCapacity(
    { totalMemoryMb: 65536, activeProfiles: 8 },
    { productLimit: 100, administratorLimit: 100, globalSafetyLimit: 3 },
  ).profileLimit, 3);
});

test('unknown memory and invalid configuration use safe defaults', () => {
  const capacity = calculateBrowserCapacity(
    { totalMemoryMb: undefined, activeProfiles: -2 },
    { productLimit: 'invalid', administratorLimit: null, globalSafetyLimit: undefined },
  );
  assert.equal(capacity.profileLimit, 1);
  assert.equal(capacity.activeProfiles, 0);
  assert.equal(capacity.atCapacity, false);
});
