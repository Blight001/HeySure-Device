'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const originalCwd = process.cwd();
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-account-storage-'));
process.chdir(fixtureRoot);
const accountStorage = require('../../../src/app/main/lib/account-storage');

test.after(() => {
  process.chdir(originalCwd);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

test('account lifecycle preserves metadata while excluding browser credentials', () => {
  accountStorage.setLicenseCache({ getCredentials: () => ({ key: 'runtime-license' }) });
  const created = accountStorage.addAccount({
    accountId: '1001',
    accountName: 'Person A',
    browserStorage: [{ key: 'token', value: 'private-storage' }],
    cookies: [{ name: 'sid', value: 'private-cookie' }],
    currentAccountType: 'one_time',
    currentPlatform: 'Dream Studio',
    currentUrl: 'https://example.test/a',
    deviceId: 'device-a',
    platform: 'dream',
    serverRecycleTime: '2026-08-01T00:00:00Z',
    storageGroup: 'group-a',
    storageType: 'custom',
  });
  assert.equal(created.ok, true);
  assert.equal(created.account.key, 'runtime-license');
  assert.deepEqual(created.account.cookies, []);
  assert.deepEqual(created.account.browserStorage, []);

  const fetched = accountStorage.getAccount('1001');
  assert.equal(fetched.ok, true);
  assert.equal(fetched.account.account, 'Person A');
  assert.equal(fetched.account.currentAccountType, 'one_time');
  assert.equal(fetched.account.cleanupProtected, true);
  assert.deepEqual(fetched.account.cookies, []);

  const updated = accountStorage.updateAccount('1001', {
    accountName: 'Person A Updated',
    cookies: [{ name: 'sid', value: 'must-not-persist' }],
    currentPlatform: 'Dream Updated',
    server_recycle_time: '2026-09-01T00:00:00Z',
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.account.account, 'Person A Updated');
  assert.equal(updated.account.currentPlatform, 'Dream Updated');
  assert.deepEqual(updated.account.cookies, []);
  assert.equal(accountStorage.updateLastUsedTime('1001').ok, true);

  const list = accountStorage.getAllAccounts();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, '1001');
  assert.equal(list[0].hasCookies, false);
  assert.equal(list[0].currentAccountType, 'one_time');
  assert.equal(list[0].cleanupProtected, true);
  assert.equal('deviceId' in list[0], false);
});

test('account ids migrate atomically and cache follows the new id', () => {
  const migrated = accountStorage.migrateAccountId('1001', 'person@example.com');
  assert.equal(migrated.ok, true);
  assert.equal(migrated.account.id, 'person@example.com');
  assert.equal(accountStorage.getAccount('1001').ok, false);
  assert.equal(accountStorage.getAccount('person@example.com').ok, true);
  assert.equal(accountStorage.migrateAccountId('person@example.com', 'person@example.com').ok, true);
  assert.equal(accountStorage.migrateAccountId('', 'target').ok, false);
  assert.equal(accountStorage.migrateAccountId('missing', 'target').ok, false);

  const last = accountStorage.getLastUsedAccount();
  assert.equal(last.ok, true);
  assert.equal(last.account.id, 'person@example.com');
});

test('missing and deleted accounts return stable failure results', () => {
  assert.equal(accountStorage.updateAccount('missing', { accountName: 'x' }).ok, false);
  assert.equal(accountStorage.updateLastUsedTime('missing').ok, false);
  assert.equal(accountStorage.deleteAccount('missing').ok, false);
  assert.equal(accountStorage.deleteAccount('person@example.com').ok, true);
  assert.equal(accountStorage.getAccount('person@example.com').ok, false);
  assert.equal(accountStorage.getLastUsedAccount().ok, false);
  assert.deepEqual(accountStorage.getAllAccounts(), []);
});
