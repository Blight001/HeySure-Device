'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  createAiServerDeviceCredentialStore,
} = require('../../../src/app/main/features/ai-chat/ai-server-device-credential-store');

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`protected:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^protected:/, ''),
  };
}

test('HeySure 自动登录凭据加密落盘、可恢复且能清除', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-heysure-credentials-'));
  const filePath = path.join(root, 'credentials.json');
  try {
    const store = createAiServerDeviceCredentialStore({ fs, path, safeStorage: fakeSafeStorage(), filePath });
    const credentials = {
      server: 'http://49.234.181.190:3000',
      account: 'alice',
      password: 'top-secret-password',
      serviceName: 'AI-FREE',
    };
    assert.equal(store.save(credentials), true);
    const raw = fs.readFileSync(filePath, 'utf8');
    assert.equal(raw.includes(credentials.password), false);
    assert.equal(raw.includes(credentials.account), false);
    assert.deepEqual(store.load(), credentials);
    assert.equal(store.clear(), true);
    assert.equal(fs.existsSync(filePath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('系统安全存储不可用时拒绝明文保存', () => {
  const store = createAiServerDeviceCredentialStore({
    fs,
    path,
    safeStorage: { isEncryptionAvailable: () => false },
    filePath: path.join(os.tmpdir(), 'unused-ai-free-heysure-credentials.json'),
  });
  assert.throws(() => store.save({ account: 'alice', password: 'secret' }), /安全凭据存储不可用/);
});
