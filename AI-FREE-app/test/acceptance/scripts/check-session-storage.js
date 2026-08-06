const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-session-storage-'));
app.setPath('userData', testRoot);
const sessionsDir = path.join(testRoot, 'account_sessions');
fs.mkdirSync(sessionsDir, { recursive: true });
const legacyPath = path.join(sessionsDir, 'legacy-account.json');
fs.writeFileSync(legacyPath, JSON.stringify({
  id: 'legacy-account',
  account: 'legacy@example.com',
  key: 'LEGACY-KEY',
  deviceId: 'legacy-device',
  cookies: [{ name: 'legacy-session', value: 'legacy-cookie' }],
  cookiesEncrypted: 'legacy-encrypted-value',
  cookiesEncryptionMethod: 'safeStorage',
  cookiesEncryptionVersion: 'v1',
  browserStorage: [{ origin: 'https://example.com', localStorage: { token: 'legacy-token' } }],
}), 'utf8');

app.whenReady().then(() => {
  const sessionStorage = require('../../../src/app/main/lib/session-storage');
  const accountId = '豆包::7-8-19-11=38@self.com';

  assert.equal(sessionStorage.saveSession(accountId, {
    key: 'JD27-TEST',
    account: '7-8-19-11=38@self.com',
    platform: '豆包',
    cookies: [{ name: 'sessionid', value: 'test-cookie', domain: '.example.com', path: '/' }],
  }), true, '包含 Windows 非法文件名字符的账号 ID 应能保存');

  const files = fs.readdirSync(sessionStorage.getSessionsDir(), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile());
  assert.equal(files.length, 2);
  assert.equal(files.some((entry) => entry.name.includes(':')), false, '落盘文件名不得包含冒号');

  assert.equal(sessionStorage.getAllSessionIds().includes(accountId), true, '账号列表应返回原始业务 ID');
  const loaded = sessionStorage.loadSession(accountId);
  assert.equal(loaded?.id, accountId);
  assert.equal(loaded?.account, '7-8-19-11=38@self.com');
  assert.deepEqual(loaded?.cookies, []);
  assert.deepEqual(loaded?.browserStorage, []);
  assert.equal(loaded?.key, '');

  const persistedFiles = fs.readdirSync(sessionStorage.getSessionsDir(), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile());
  for (const entry of persistedFiles) {
    const raw = JSON.parse(fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8'));
    for (const field of [
      'cookies', 'cookiesEncrypted', 'cookiesEncryptionMethod', 'cookiesEncryptionVersion',
      'browserStorage', 'key', 'deviceId',
    ]) {
      assert.equal(Object.hasOwn(raw, field), false, `${field} 不得写入 account_sessions`);
    }
  }

  const migratedLegacy = sessionStorage.loadSession('legacy-account');
  assert.deepEqual(migratedLegacy?.cookies, []);
  assert.deepEqual(migratedLegacy?.browserStorage, []);

  assert.equal(sessionStorage.deleteSession(accountId), true, '应能使用原始业务 ID 删除哈希文件');
  assert.equal(sessionStorage.getAllSessionIds().includes(accountId), false);

  console.log('Session storage checks passed.');
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

app.on('quit', () => {
  try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (_) {}
});
