'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  initializeAccountCleanup,
  resolveRecycleTimestamp,
  updateAccountRecycleTimer,
} = require('../../../src/app/main/utils/accountCleanup');

test('recycle timestamp accepts explicit, nested and relative server fields', () => {
  assert.equal(resolveRecycleTimestamp(null), null);
  assert.equal(resolveRecycleTimestamp({ serverRecycleTimeTs: 1234567890000 }), 1234567890000);
  assert.equal(resolveRecycleTimestamp({ serverRecycleTimeIso: '2030-01-01T00:00:00Z' }), Date.parse('2030-01-01T00:00:00Z'));
  assert.equal(resolveRecycleTimestamp({ refresh_info: { next_refresh_at: '2031-01-01T00:00:00Z' } }), Date.parse('2031-01-01T00:00:00Z'));
  const beforeSeconds = Date.now();
  const fromSeconds = resolveRecycleTimestamp({ remaining_seconds: 5 });
  assert.ok(fromSeconds >= beforeSeconds + 5000 && fromSeconds <= Date.now() + 5000);
  const beforeMinutes = Date.now();
  const fromMinutes = resolveRecycleTimestamp({ refreshInfo: { remainingMinutes: 2 } });
  assert.ok(fromMinutes >= beforeMinutes + 120000 && fromMinutes <= Date.now() + 120000);
  assert.equal(resolveRecycleTimestamp({ ai_account_expiry_time: '2032-01-01T00:00:00Z' }), Date.parse('2032-01-01T00:00:00Z'));
  assert.equal(resolveRecycleTimestamp({}), null);
});

test('initial cleanup deletes expired temporary accounts serially and notifies once', async () => {
  const deleted = [];
  const artifacts = [];
  const events = [];
  const expired = Date.now() - 1000;
  const accountStorage = {
    getAllAccounts: () => [
      { id: 'expired-a', serverRecycleTimeTs: expired },
      { id: 'expired-b', serverRecycleTimeTs: expired },
      { id: 'permanent', currentAccountType: 'one_time', serverRecycleTimeTs: expired },
      { id: 'protected', cleanupProtected: true },
      { id: '', serverRecycleTimeTs: expired },
    ],
    deleteAccount: (id) => { deleted.push(id); return { ok: true }; },
  };
  const result = await initializeAccountCleanup(accountStorage, {
    cleanupAccountArtifacts: async (id) => { artifacts.push(id); return { ok: true }; },
    sendToSide: (...args) => events.push(args),
  });
  assert.deepEqual(result, { scheduled: 0, removed: 2 });
  assert.deepEqual(deleted, ['expired-a', 'expired-b']);
  assert.deepEqual(artifacts, ['expired-a', 'expired-b']);
  assert.deepEqual(events, [['account-list-updated', {}]]);
  assert.deepEqual(await initializeAccountCleanup(null), { scheduled: 0, removed: 0 });
});

test('timer updates resolve records by id and delete them after expiry', async () => {
  const deleted = [];
  const account = { id: 'timer-account', serverRecycleTimeTs: Date.now() - 1 };
  const storage = {
    getAccount: (id) => id === account.id ? { ok: true, account } : { ok: false },
    deleteAccount: (id) => { deleted.push(id); return { ok: true }; },
  };
  assert.equal(updateAccountRecycleTimer(null, account), false);
  assert.equal(updateAccountRecycleTimer(storage, 'missing'), false);
  assert.equal(updateAccountRecycleTimer(storage, 'timer-account'), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(deleted, ['timer-account']);
  assert.equal(updateAccountRecycleTimer(storage, { id: 'permanent', currentAccountType: 'one_time', serverRecycleTimeTs: Date.now() - 1 }), false);
  assert.equal(updateAccountRecycleTimer(storage, { id: '', serverRecycleTimeTs: Date.now() - 1 }), false);
});
