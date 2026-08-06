'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ACCOUNT_AUTH_TYPE,
  buildStoredAccountSession,
  normalizeAccountSession,
  serializeAccountSession,
} = require('../../../src/app/main/utils/account-session');

test('account session normalizes session aliases and clones public payloads', () => {
  const source = {
    auth_type: ' ACCOUNT ', username: ' alice ', session_token: ' afs_test ', device_id: ' device ',
    platform_name: ' fixture ', server_base: 'https://service.example///', server_mode: 'remote',
    authenticated_at: 'now', account: { id: 1 }, validation: { ok: true },
  };
  const session = normalizeAccountSession(source);
  assert.equal(ACCOUNT_AUTH_TYPE, 'account');
  assert.equal(session.authenticated, true);
  assert.equal(session.serverBase, 'https://service.example');
  assert.equal(session.sessionToken, 'afs_test');
  assert.equal(session.key, 'afs_test');
  assert.notEqual(session.account, source.account);
  assert.notEqual(session.validation, source.validation);
});

test('authentication requires every trusted field and rejects legacy tenant URLs', () => {
  const valid = { authType: 'account', username: 'a', sessionToken: 'afs_test', deviceId: 'd', serverBase: 'https://service.example' };
  for (const field of ['username', 'sessionToken', 'deviceId', 'serverBase']) {
    assert.equal(normalizeAccountSession({ ...valid, [field]: '' }).authenticated, false, field);
  }
  assert.equal(normalizeAccountSession({ ...valid, authType: 'license' }).authenticated, false);
  assert.equal(normalizeAccountSession({ ...valid, tenantId: 'legacy' }).authenticated, false);
  assert.equal(normalizeAccountSession({ ...valid, serverBase: 'https://service.example/t/legacy/api' }).authenticated, false);
  assert.equal(normalizeAccountSession(null).authenticated, false);
});

test('serialization strips derived state and discards invalid or circular objects', () => {
  const circular = {}; circular.self = circular;
  const stored = buildStoredAccountSession({
    current: null, username: 'alice', sessionToken: 'afs_test', deviceId: 'device', platformName: 'fixture',
    serverBase: 'https://service.example', account: circular, validation: [], authenticatedAt: 'now',
  });
  assert.equal('authenticated' in stored, false);
  assert.equal('key' in stored, false);
  assert.deepEqual(stored.account, {});
  assert.deepEqual(stored.validation, {});
  assert.deepEqual(serializeAccountSession({ authType: 'account' }), {});
  assert.deepEqual(buildStoredAccountSession(), {});
});
