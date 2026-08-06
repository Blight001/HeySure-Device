const { readStoreConfigFile, writeStoreConfigFile } = require('../utils/json-store');
const {
  normalizeLicenseRecord: normalizeLicenseRecordBase,
  normalizeLicenseRecords,
} = require('../utils/license-records');

function recordKey(record) {
  return String(record?.keyValue || record?.key || '').trim();
}

class LicenseStore {
  constructor(deps) {
    this.deps = deps;
    this.fs = deps.fs;
    this.path = deps.path;
    this.licenseCache = deps.licenseCache;
    this.logger = deps.logger || console;
  }

  readStoreConfigSafe() {
    return readStoreConfigFile(this.deps.getStorePath, { fs: this.fs, fallback: {} });
  }

  writeStoreConfigSafe(nextConfig) {
    return writeStoreConfigFile(this.deps.getStorePath, nextConfig, {
      fs: this.fs,
      path: this.path,
      logger: this.logger,
      logPrefix: '配置',
      writeErrorMessage: '写入 store 失败:',
    });
  }

  getLegacyLicenseRecordsPaths() {
    try {
      const baseDir = this.path.dirname(this.deps.getStorePath());
      const legacyRootDir = this.path.dirname(baseDir);
      return [
        this.path.join(baseDir, 'license-records'),
        this.path.join(baseDir, 'license-records.json'),
        this.path.join(legacyRootDir, 'license-records'),
        this.path.join(legacyRootDir, 'license-records.json'),
      ];
    } catch (_) {
      return [];
    }
  }

  maskValue(value) {
    const text = String(value || '').trim();
    if (!text || text.length <= 8) return text;
    return `${text.slice(0, 4)}****${text.slice(-4)}`;
  }

  normalizeLicenseRecord(entry = {}) {
    return normalizeLicenseRecordBase(entry, { includeTimestamps: true, requireSuccessStatus: true });
  }

  sanitizeLicenseRecords(records) {
    return normalizeLicenseRecords(records, { includeTimestamps: true, requireSuccessStatus: true });
  }

  appendCachedRecords(target) {
    if (typeof this.licenseCache?.getRecords === 'function') target.push(...this.licenseCache.getRecords());
  }

  appendStoreRecords(target, storeConfig) {
    if (Array.isArray(storeConfig.licenseRecords)) target.push(...storeConfig.licenseRecords);
    if (Array.isArray(storeConfig.license_records)) target.push(...storeConfig.license_records);
    const savedKey = String(storeConfig.userCredentials?.key || '').trim();
    if (savedKey && !target.some((item) => recordKey(item) === savedKey)) {
      target.unshift({ keyValue: savedKey, platformName: this.getCurrentPlatformLabelSafe() });
    }
  }

  appendLegacyFileRecords(target, legacyPath) {
    try {
      if (!legacyPath || !this.fs.existsSync(legacyPath) || this.fs.statSync(legacyPath).isDirectory()) return;
      const parsed = JSON.parse(this.fs.readFileSync(legacyPath, 'utf8') || '[]');
      if (Array.isArray(parsed)) {
        target.push(...parsed);
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      if (Array.isArray(parsed.records)) target.push(...parsed.records);
      if (Array.isArray(parsed.licenseRecords)) target.push(...parsed.licenseRecords);
    } catch (_) {}
  }

  readLicenseRecordsSafe() {
    try {
      const sourceRecords = [];
      this.appendCachedRecords(sourceRecords);
      this.appendStoreRecords(sourceRecords, this.readStoreConfigSafe());
      this.getLegacyLicenseRecordsPaths().forEach((filePath) => this.appendLegacyFileRecords(sourceRecords, filePath));
      const cleaned = this.sanitizeLicenseRecords(sourceRecords);
      if (cleaned.length && typeof this.licenseCache?.setRecords === 'function') this.licenseCache.setRecords(cleaned);
      return cleaned;
    } catch (_) {
      return [];
    }
  }

  writeLicenseRecordsSafe(records) {
    try {
      const cleaned = this.sanitizeLicenseRecords(records);
      const nextConfig = { ...this.readStoreConfigSafe(), licenseRecords: cleaned };
      delete nextConfig.license_records;
      this.licenseCache?.setRecords?.(cleaned);
      return this.writeStoreConfigSafe(nextConfig);
    } catch (error) {
      this.logger.warn?.('[验证记录] 写入失败:', error?.message || error);
      return false;
    }
  }

  getCurrentPlatformLabelSafe() {
    try {
      const runtimeConfig = this.licenseCache?.getRuntimeConfig?.() || {};
      const platformName = String(runtimeConfig.platformName || '').trim();
      if (platformName) return platformName;
      const runtimePlatforms = Array.isArray(runtimeConfig.allowedPlatforms) ? runtimeConfig.allowedPlatforms : [];
      if (runtimePlatforms.length) return String(runtimePlatforms[0] || '').trim() || '未知平台';
      const latest = this.deps.getLatestAllowedPlatforms?.();
      const allowedPlatforms = Array.isArray(latest) ? latest : [];
      return String(allowedPlatforms[0] || '').trim() || '未知平台';
    } catch (_) {
      return '未知平台';
    }
  }

  appendLicenseRecord(entry = {}) {
    const now = new Date().toISOString();
    const normalized = this.normalizeLicenseRecord({
      ...entry,
      savedAt: String(entry.savedAt || now).trim(),
      updatedAt: String(entry.updatedAt || now).trim(),
    });
    if (!normalized) return null;
    const records = this.readLicenseRecordsSafe();
    this.writeLicenseRecordsSafe([normalized, ...records.filter((item) => recordKey(item) !== normalized.keyValue)]);
    return normalized;
  }

  updateLicenseRecordPlatform(entry = {}) {
    const keyValue = String(entry.keyValue || entry.key || '').trim();
    const platformName = String(entry.platformName || entry.platform || entry.currentPlatformName || '').trim();
    if (!keyValue || !platformName) return null;
    const records = this.readLicenseRecordsSafe();
    let updated = false;
    const updatedAt = new Date().toISOString();
    const nextRecords = records.map((item) => {
      if (recordKey(item) !== keyValue) return item;
      updated = true;
      return { ...item, platformName, updatedAt };
    });
    if (!updated) nextRecords.unshift({ keyValue, platformName, savedAt: updatedAt, updatedAt });
    this.writeLicenseRecordsSafe(nextRecords);
    return { keyValue, platformName, updated };
  }

  toApi() {
    return {
      readStoreConfigSafe: this.readStoreConfigSafe.bind(this),
      writeStoreConfigSafe: this.writeStoreConfigSafe.bind(this),
      getCurrentPlatformLabel: this.getCurrentPlatformLabelSafe.bind(this),
      normalizeLicenseRecord: this.normalizeLicenseRecord.bind(this),
      sanitizeLicenseRecords: this.sanitizeLicenseRecords.bind(this),
      readLicenseRecordsSafe: this.readLicenseRecordsSafe.bind(this),
      writeLicenseRecordsSafe: this.writeLicenseRecordsSafe.bind(this),
      maskLicenseKey: this.maskValue.bind(this),
      maskDeviceId: this.maskValue.bind(this),
      appendLicenseRecord: this.appendLicenseRecord.bind(this),
      updateLicenseRecordPlatform: this.updateLicenseRecordPlatform.bind(this),
    };
  }
}

function createLicenseStore(deps = {}) {
  return new LicenseStore(deps).toApi();
}

module.exports = { createLicenseStore };
