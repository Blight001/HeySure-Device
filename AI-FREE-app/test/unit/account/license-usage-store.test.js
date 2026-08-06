'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createLicenseUsageStore } = require('../../../src/app/main/features/account/license-usage-store');

function fixture(snapshot = {}) {
  const states = [];
  const events = [];
  const cache = {
    getSnapshot: () => snapshot,
    setValidationState: (state) => { states.push(state); snapshot = { ...snapshot, ...state }; return state; },
  };
  return {
    events, states,
    store: createLicenseUsageStore({
      getRuntimeLicenseCache: () => cache,
      sendToSide: (...args) => events.push(args),
    }),
  };
}

test('stored usage validates credentials and normalizes usage aliases', () => {
  const data = fixture({ key: 'key', deviceId: 'device', licenseUsage: {
    max_usage_times: 10, used_usage_times: 3, remaining_usage_times: 7,
  } });
  assert.equal(data.store.getStoredLicenseUsage('other', 'device'), null);
  assert.equal(data.store.getStoredLicenseUsage('key', 'other'), null);
  assert.deepEqual(data.store.getStoredLicenseUsage('key', 'device'), {
    max_usage_times: 10, used_usage_times: 3, remaining_usage_times: 7, key: 'key', deviceId: 'device',
  });
});

test('saving usage snapshots updates validation state and notifies sidebar', () => {
  const data = fixture();
  const saved = data.store.saveLicenseUsageSnapshot({
    key: 'key', deviceId: 'device', source: {
      maxUsageTimes: 5, usedUsageTimes: 1, remainingUsageTimes: 4,
      current_account_type: 'shared', message: 'ready',
    },
  });
  assert.equal(saved.maxUsageTimes, 5);
  assert.equal(saved.currentAccountType, 'shared');
  assert.equal(data.events[0][0], 'license-usage-updated');
});

test('local consumption decrements remaining usage and increments used usage', () => {
  const data = fixture({ key: 'key', deviceId: 'device', licenseUsage: {
    max_usage_times: 3, used_usage_times: 1, remaining_usage_times: 2,
  } });
  const consumed = data.store.consumeLocalLicenseUsage({ key: 'key', deviceId: 'device' });
  assert.equal(consumed.remainingUsageTimes, 1);
  assert.equal(consumed.usedUsageTimes, 2);
  assert.equal(data.states.length, 1);
});

test('missing caches and invalid usage return null without side effects', () => {
  const unavailable = createLicenseUsageStore({ getRuntimeLicenseCache: () => null });
  assert.equal(unavailable.getStoredLicenseUsage(), null);
  assert.equal(unavailable.saveLicenseUsageSnapshot({}), null);
  assert.equal(unavailable.consumeLocalLicenseUsage(), null);
  const empty = fixture({ key: 'key', deviceId: 'device' });
  assert.equal(empty.store.consumeLocalLicenseUsage(), null);
});
