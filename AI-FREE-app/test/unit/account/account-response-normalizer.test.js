'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  extractCurrentAccountTypeInfo,
  extractServerRecycleDebugInfo,
  extractServerRecycleTimeInfo,
} = require('../../../src/app/main/features/account/account-response-normalizer');

test('account response normalization reads snake/camel fields from nested response envelopes', () => {
  assert.deepEqual(extractCurrentAccountTypeInfo({
    result: { currentAccountType: 'svip', current_account_type_label: 'SVIP' },
  }), {
    currentAccountType: 'svip',
    currentAccountTypeLabel: 'SVIP',
  });

  const recycle = extractServerRecycleTimeInfo({
    payload: { refreshInfo: { nextRefreshAt: '2026-08-01T00:00:00.000Z' } },
  });
  assert.equal(recycle.serverRecycleTimeTs, Date.parse('2026-08-01T00:00:00.000Z'));
  assert.equal(recycle.serverRecycleTimeIso, '2026-08-01T00:00:00.000Z');
});

test('explicit recycle time wins and debug values preserve zero while removing empty fields', () => {
  const source = {
    server_recycle_time: '2026-09-01T00:00:00.000Z',
    data: {
      refresh_info: { next_refresh_at: '2026-10-01T00:00:00.000Z', remaining_seconds: 0 },
      ai_account_expiry_time: '',
    },
  };
  const recycle = extractServerRecycleTimeInfo(source);
  const debug = extractServerRecycleDebugInfo(source);
  assert.equal(recycle.serverRecycleTime, '2026-09-01T00:00:00.000Z');
  assert.equal(debug.nextRefreshAt, '2026-10-01T00:00:00.000Z');
  assert.equal(debug.remainingSeconds, 0);
  assert.equal(debug.aiAccountExpiryTime, undefined);
});
