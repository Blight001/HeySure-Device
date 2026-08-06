'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const { resolveCurrentAccountType } = require('../../utils/normalizers');

const SESSION_CREDENTIAL_FIELDS = [
  'cookies', 'cookiesEncrypted', 'cookiesEncryptionMethod', 'cookiesEncryptionVersion',
  'browserStorage', 'key', 'deviceId',
];
const REMOVED_METADATA_FIELDS = [
  ...SESSION_CREDENTIAL_FIELDS, 'accountName', 'storageType', 'storageGroup', 'storageGroupLabel',
];

function text(value) {
  return String(value || '').trim();
}

class SessionStoragePaths {
  constructor() {
    this.metadataMigrationDone = false;
    this.sessionsDirCache = null;
  }

  getSessionsDir() {
    if (this.sessionsDirCache) return this.sessionsDirCache;
    let userDataDir = '';
    try { userDataDir = app?.getPath?.('userData') || ''; } catch (_) {}
    this.sessionsDirCache = path.join(userDataDir || path.join(process.cwd(), 'userData'), 'account_sessions');
    return this.sessionsDirCache;
  }

  ensureSessionsDir() {
    try {
      const sessionsDir = this.getSessionsDir();
      if (!fs.existsSync(sessionsDir)) {
        fs.mkdirSync(sessionsDir, { recursive: true });
        console.log('[SessionStorage] 创建会话目录:', sessionsDir);
      }
      this.migrateSessionMetadataOnly();
    } catch (error) {
      console.error('[SessionStorage] 创建会话目录失败:', error?.message || error);
    }
  }

  normalizeKeyFolderName(key) {
    const value = text(key);
    if (!value) return '__no_key__';
    const hash = crypto.createHash('sha1').update(value).digest('hex').slice(0, 12);
    const prefix = value.slice(0, 6).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_')
      .replace(/_+/g, '_').replace(/^_|_$/g, '') || 'key';
    return `${prefix}_${hash}`;
  }

  getSessionFileName(accountId) {
    const value = text(accountId);
    const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
    const portable = value && value !== '.' && value !== '..'
      && Buffer.byteLength(value, 'utf8') <= 180 && !/[<>:"/\\|?*\x00-\x1f]/.test(value)
      && !/[. ]$/.test(value) && !reserved.test(value);
    return portable ? value : `account-${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
  }

  getKeyFolderPath(key) {
    return path.join(this.getSessionsDir(), this.normalizeKeyFolderName(key));
  }

  getSessionFilePath(accountId, key, storageType = 'server', storageGroup = '') {
    const fileName = this.getSessionFileName(accountId);
    if (this.normalizeStorageType(storageType) === 'server') return path.join(this.getKeyFolderPath(key), fileName);
    return path.join(this.getStorageRootDir(storageType, storageGroup), this.normalizeKeyFolderName(key), fileName);
  }

  getLegacyRootSessionPath(accountId) {
    return path.join(this.getSessionsDir(), this.getSessionFileName(accountId));
  }

  getLegacyRootSessionJsonPath(accountId) {
    return `${this.getLegacyRootSessionPath(accountId)}.json`;
  }

  normalizeFolderPart(value, fallback = 'default') {
    const valueText = text(value);
    if (!valueText) return fallback;
    return valueText.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_')
      .replace(/_+/g, '_').replace(/^_|_$/g, '') || fallback;
  }

  normalizeStorageType(value) {
    const valueText = text(value || 'server').toLowerCase();
    return ['custom', 'manual', 'server'].includes(valueText) ? valueText : 'server';
  }

  isPermanentAccountSession(sessionInfo) {
    return resolveCurrentAccountType(sessionInfo?.currentAccountType, sessionInfo?.currentAccountTypeLabel) === 'one_time';
  }

  isProtectedSession(sessionInfo) {
    const type = resolveCurrentAccountType(sessionInfo?.currentAccountType, sessionInfo?.currentAccountTypeLabel);
    if (type === 'one_time') return true;
    if (type === 'shared') return false;
    return sessionInfo?.cleanupProtected === true;
  }

  createLegacyMetadata(filePath) {
    return {
      id: path.basename(filePath).replace(/\.json$/, ''), savedAt: null, lastUsedAt: null,
      serverRecycleTime: '', serverRecycleTimeTs: null, serverRecycleTimeIso: '', platform: '',
      currentPlatform: '', currentUrl: '', account: '', cleanupProtected: false,
      currentAccountType: '', currentAccountTypeLabel: '',
    };
  }

  sanitizeMetadata(parsed, filePath) {
    const metadata = Array.isArray(parsed) ? this.createLegacyMetadata(filePath) : { ...parsed };
    let changed = Array.isArray(parsed);
    if (!text(metadata.account) && text(metadata.accountName)) {
      metadata.account = text(metadata.accountName);
      changed = true;
    }
    for (const field of REMOVED_METADATA_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(metadata, field)) continue;
      delete metadata[field];
      changed = true;
    }
    return { metadata, changed };
  }

  migrateMetadataFile(filePath) {
    try {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return;
      const content = text(fs.readFileSync(filePath, 'utf8'));
      if (!content) return;
      const result = this.sanitizeMetadata(JSON.parse(content), filePath);
      if (result.changed) fs.writeFileSync(filePath, JSON.stringify(result.metadata, null, 2), 'utf8');
    } catch (_) {}
  }

  migrateSessionMetadataOnly() {
    try {
      if (this.metadataMigrationDone) return;
      this.metadataMigrationDone = true;
      const sessionsDir = this.getSessionsDir();
      if (!fs.existsSync(sessionsDir)) return;
      this.walkSessionFiles(sessionsDir).forEach((filePath) => this.migrateMetadataFile(filePath));
    } catch (error) {
      console.warn('[SessionStorage] 迁移账号元数据失败:', error?.message || error);
    }
  }

  walkSessionFiles(dir, out = []) {
    try {
      if (!fs.existsSync(dir)) return out;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) this.walkSessionFiles(fullPath, out);
        else out.push(fullPath);
      }
    } catch (_) {}
    return out;
  }

  matchesSessionFile(filePath, normalizedAccountId, sessionFileName) {
    const baseName = path.basename(filePath).replace(/\.json$/, '');
    if (baseName === normalizedAccountId || baseName === sessionFileName) return true;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return Boolean(parsed && !Array.isArray(parsed) && text(parsed.id) === normalizedAccountId);
    } catch (_) {
      return false;
    }
  }

  findSessionPaths(accountId) {
    try {
      const normalizedId = text(accountId);
      const direct = [
        this.getLegacyRootSessionPath(accountId), this.getLegacyRootSessionJsonPath(accountId),
        this.getSessionFilePath(accountId, ''), this.getSessionFilePath(accountId, '', 'manual'),
      ].filter((candidate) => fs.existsSync(candidate));
      if (direct.length) return Array.from(new Set(direct));
      const fileName = this.getSessionFileName(normalizedId);
      const matches = this.walkSessionFiles(this.getSessionsDir())
        .filter((filePath) => this.matchesSessionFile(filePath, normalizedId, fileName));
      return Array.from(new Set(matches));
    } catch (_) {
      return [];
    }
  }

  getStorageRootDir(storageType, storageGroup) {
    const type = this.normalizeStorageType(storageType);
    const sessionsDir = this.getSessionsDir();
    if (type === 'custom') return path.join(sessionsDir, 'custom', this.normalizeFolderPart(storageGroup, 'default'));
    if (type === 'manual') return path.join(sessionsDir, 'manual');
    return sessionsDir;
  }

  inferSessionLocationInfo(filePath) {
    const fallback = { storageType: 'server', storageGroup: '', storageGroupLabel: '' };
    try {
      const relativePath = path.relative(path.resolve(this.getSessionsDir()), path.resolve(filePath || ''));
      if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return fallback;
      const segments = relativePath.split(path.sep).filter(Boolean);
      if (segments[0] === 'custom') {
        const storageGroup = segments[1] || '';
        return { storageType: 'custom', storageGroup, storageGroupLabel: storageGroup };
      }
      if (segments[0] === 'manual') return { storageType: 'manual', storageGroup: '', storageGroupLabel: 'manual' };
      return fallback;
    } catch (_) {
      return fallback;
    }
  }

  pruneEmptyDir(dirPath) {
    try {
      if (!dirPath || dirPath === this.getSessionsDir() || !fs.existsSync(dirPath)) return;
      if (!fs.readdirSync(dirPath).length) fs.rmdirSync(dirPath);
    } catch (_) {}
  }

  toApi() {
    const methods = [
      'ensureSessionsDir', 'findSessionPaths', 'getKeyFolderPath', 'getLegacyRootSessionJsonPath',
      'getLegacyRootSessionPath', 'getSessionFileName', 'getSessionFilePath', 'getSessionsDir',
      'getStorageRootDir', 'inferSessionLocationInfo', 'isPermanentAccountSession', 'isProtectedSession',
      'migrateSessionMetadataOnly', 'normalizeFolderPart', 'normalizeKeyFolderName', 'normalizeStorageType',
      'pruneEmptyDir', 'walkSessionFiles',
    ];
    const api = { SESSION_CREDENTIAL_FIELDS };
    methods.forEach((method) => { api[method] = this[method].bind(this); });
    return api;
  }
}

function createSessionStoragePaths() {
  return new SessionStoragePaths().toApi();
}

module.exports = { createSessionStoragePaths };
