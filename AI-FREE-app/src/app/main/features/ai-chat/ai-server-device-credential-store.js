'use strict';

const crypto = require('crypto');

const CREDENTIAL_FILE_VERSION = 1;

class AiServerDeviceCredentialStore {
  constructor(options = {}) {
    this.fs = options.fs;
    this.path = options.path;
    this.safeStorage = options.safeStorage;
    this.filePath = this.path.resolve(String(options.filePath || ''));
    this.logger = options.logger || console;
  }

  assertEncryptionAvailable() {
    if (!this.safeStorage?.isEncryptionAvailable?.()) {
      throw new Error('系统安全凭据存储不可用，无法启用 HeySure 自动登录');
    }
  }

  has() {
    try { return this.fs.existsSync(this.filePath); } catch (_) { return false; }
  }

  save(credentials) {
    this.assertEncryptionAvailable();
    const plaintext = JSON.stringify({
      server: String(credentials.server || ''),
      account: String(credentials.account || ''),
      password: String(credentials.password || ''),
      serviceName: String(credentials.serviceName || 'AI-FREE'),
    });
    const encrypted = this.safeStorage.encryptString(plaintext).toString('base64');
    const payload = JSON.stringify({ version: CREDENTIAL_FILE_VERSION, encrypted });
    const directory = this.path.dirname(this.filePath);
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
    this.fs.mkdirSync(directory, { recursive: true });
    try {
      this.fs.writeFileSync(temporary, `${payload}\n`, { encoding: 'utf8', mode: 0o600 });
      this.fs.renameSync(temporary, this.filePath);
      try { this.fs.chmodSync(this.filePath, 0o600); } catch (_) {}
    } finally {
      try { if (this.fs.existsSync(temporary)) this.fs.unlinkSync(temporary); } catch (_) {}
    }
    return true;
  }

  load() {
    if (!this.has()) return null;
    this.assertEncryptionAvailable();
    try {
      const payload = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'));
      if (payload?.version !== CREDENTIAL_FILE_VERSION || !payload.encrypted) {
        throw new Error('凭据文件版本或内容无效');
      }
      const plaintext = this.safeStorage.decryptString(Buffer.from(payload.encrypted, 'base64'));
      const credentials = JSON.parse(plaintext);
      if (!credentials?.account || !credentials?.password) throw new Error('凭据内容不完整');
      return credentials;
    } catch (error) {
      this.logger.warn?.('[AIServerDevice] 已保存的自动登录凭据无法读取:', error?.message || error);
      return null;
    }
  }

  clear() {
    try {
      if (this.fs.existsSync(this.filePath)) this.fs.unlinkSync(this.filePath);
      return true;
    } catch (error) {
      this.logger.warn?.('[AIServerDevice] 清除自动登录凭据失败:', error?.message || error);
      return false;
    }
  }
}

function createAiServerDeviceCredentialStore(options = {}) {
  return new AiServerDeviceCredentialStore(options);
}

module.exports = {
  AiServerDeviceCredentialStore,
  CREDENTIAL_FILE_VERSION,
  createAiServerDeviceCredentialStore,
};
