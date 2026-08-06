'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const originalCwd = process.cwd();
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-session-storage-'));
process.chdir(fixtureRoot);
const sessionStorage = require('../../../src/app/main/lib/session-storage');

test.after(() => {
  process.chdir(originalCwd);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

test('session metadata round-trips without persisting credentials', () => {
  const accountId = 'dream::person@example.com';
  const saved = sessionStorage.saveSession(accountId, {
    account: 'person@example.com',
    browserStorage: [{ key: 'secret' }],
    cookies: [{ name: 'session', value: 'secret' }],
    currentAccountType: 'one_time',
    currentPlatform: 'Dream',
    currentUrl: 'https://example.test/workspace',
    deviceId: 'device-secret',
    key: 'license-secret',
    lastUsedAt: '2026-07-19T00:00:00.000Z',
    platform: 'dream',
    storageGroup: '绑定 账号',
    storageType: 'custom',
  });
  assert.equal(saved, true);

  const loaded = sessionStorage.loadSession(accountId);
  assert.equal(loaded.id, accountId);
  assert.equal(loaded.account, 'person@example.com');
  assert.equal(loaded.storageType, 'custom');
  assert.equal(loaded.cleanupProtected, true);
  assert.equal(loaded.currentAccountType, 'one_time');
  assert.deepEqual(loaded.cookies, []);
  assert.deepEqual(loaded.browserStorage, []);
  assert.equal(loaded.key, '');
  assert.equal(loaded.deviceId, '');

  const files = listFiles(sessionStorage.getSessionsDir());
  assert.equal(files.length, 1);
  const raw = fs.readFileSync(files[0], 'utf8');
  assert.doesNotMatch(raw, /secret|cookies|browserStorage|deviceId/);
  assert.deepEqual(sessionStorage.getAllSessionIds(), [accountId]);
  assert.equal(sessionStorage.deleteSession(accountId), true);
});

test('legacy flat sessions migrate and credential fields are removed in place', () => {
  const accountId = 'legacy-account';
  const sessionsDir = sessionStorage.getSessionsDir();
  fs.mkdirSync(sessionsDir, { recursive: true });
  const legacyPath = path.join(sessionsDir, `${accountId}.json`);
  fs.writeFileSync(legacyPath, JSON.stringify({
    id: accountId,
    accountName: 'Legacy Person',
    cookies: [{ name: 'sid', value: 'private' }],
    browserStorage: [{ key: 'private' }],
    key: 'private-key',
    storageType: 'custom',
  }));

  const loaded = sessionStorage.loadSession(accountId);
  assert.equal(loaded.id, accountId);
  assert.equal(loaded.account, 'Legacy Person');
  assert.deepEqual(loaded.cookies, []);
  assert.equal(fs.existsSync(legacyPath), false);
  const migrated = listFiles(sessionsDir)
    .map((file) => fs.readFileSync(file, 'utf8'))
    .find((content) => content.includes(accountId));
  assert.ok(migrated);
  assert.doesNotMatch(migrated, /private|cookies|browserStorage/);
  assert.equal(sessionStorage.deleteSession(accountId), true);
});

test('portable and unsafe account ids remain addressable and deletable', () => {
  const ids = ['plain-account', 'CON', 'platform::name/with*invalid?chars'];
  for (const id of ids) {
    assert.equal(sessionStorage.saveSession(id, { account: id }), true);
    assert.equal(sessionStorage.loadSession(id)?.id, id);
  }
  assert.deepEqual(sessionStorage.getAllSessionIds().sort(), ids.slice().sort());
  for (const id of ids) assert.equal(sessionStorage.deleteSession(id), true);
  assert.deepEqual(sessionStorage.getAllSessionIds(), []);
  assert.equal(sessionStorage.deleteSession('missing'), false);
  assert.equal(sessionStorage.loadSession('missing'), null);
});

function listFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(target));
    else files.push(target);
  }
  return files;
}
