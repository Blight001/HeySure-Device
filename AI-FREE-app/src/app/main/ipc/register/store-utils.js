const { getStorePath } = require('../../config');
const {
  readStoreConfigFile,
  writeStoreConfigFile,
} = require('../../utils/json-store');
const { sanitizeUserFacingMessage } = require('../../utils/messages');
const { toFiniteNumber } = require('../../utils/normalizers');

// 获取/读取/解析：readStoreConfigSafe的具体业务逻辑。
function readStoreConfigSafe() {
  return readStoreConfigFile(getStorePath);
}

// 设置/更新/持久化：writeStoreConfigSafe的具体业务逻辑。
function writeStoreConfigSafe(storeConfig) {
  return writeStoreConfigFile(getStorePath, storeConfig);
}

function buildStoreWithLicenseKey(currentStore, key, deviceId) {
  const store = currentStore && typeof currentStore === 'object' ? currentStore : {};
  const credentials = store.userCredentials && typeof store.userCredentials === 'object'
    ? store.userCredentials
    : {};
  const nextStore = { ...store, userCredentials: { ...credentials, key } };
  if (deviceId) nextStore.userCredentials.deviceId = deviceId;
  return nextStore;
}

function updateLicenseCacheCredentials(licenseCache, key, deviceId) {
  if (!licenseCache || typeof licenseCache.setCredentials !== 'function') return;
  licenseCache.setCredentials({ key, deviceId });
}

// 设置/更新/持久化：persistSavedLicenseKeySafe的具体业务逻辑。
/** @param {Record<string, any>} [deps] */
function persistSavedLicenseKeySafe({ readStoreConfigSafe, writeStoreConfigSafe, licenseCache } = {}, key = '', deviceId = '') {
  try {
    const normalizedKey = String(key || '').trim();
    const normalizedDeviceId = String(deviceId || '').trim();
    if (!normalizedKey) {
      return false;
    }

    const currentStore = typeof readStoreConfigSafe === 'function' ? readStoreConfigSafe() : {};
    const nextStore = buildStoreWithLicenseKey(currentStore, normalizedKey, normalizedDeviceId);

    const wroteStore = typeof writeStoreConfigSafe === 'function' ? writeStoreConfigSafe(nextStore) : false;
    updateLicenseCacheCredentials(licenseCache, normalizedKey, normalizedDeviceId);
    return wroteStore === true;
  } catch (_) {
    return false;
  }
}

// 设置/更新/持久化：saveLicenseCredentialsSafe的具体业务逻辑。
/** @param {Record<string, any>} [deps] */
function saveLicenseCredentialsSafe(deps = {}, key = '', deviceId = '') {
  const normalizedKey = String(key || '').trim();
  const normalizedDeviceId = String(deviceId || '').trim();
  const { licenseCache } = deps || {};

  if (licenseCache && typeof licenseCache.setCredentials === 'function') {
    licenseCache.setCredentials({
      key: normalizedKey,
      deviceId: normalizedDeviceId,
    });
  }

  if (!normalizedKey) {
    return false;
  }

  return persistSavedLicenseKeySafe(deps, normalizedKey, normalizedDeviceId);
}

// 格式化/规范化：normalizeLicenseBinding的具体业务逻辑。
/** @param {Record<string, any>} [source] */
function normalizeLicenseBinding(source = {}) {
  return {
    canSelfUnbind: source.can_self_unbind === true || source.canSelfUnbind === true,
    maxUsageTimes: toFiniteNumber(source.max_usage_times ?? source.maxUsageTimes),
    usedUsageTimes: toFiniteNumber(source.used_usage_times ?? source.usedUsageTimes),
    remainingUsageTimes: toFiniteNumber(source.remaining_usage_times ?? source.remainingUsageTimes),
    remainingUnbindTimes: toFiniteNumber(source.remaining_unbind_times ?? source.remainingUnbindTimes),
    maxUnbindTimes: toFiniteNumber(source.max_unbind_times ?? source.maxUnbindTimes),
    usedUnbindTimes: toFiniteNumber(source.used_unbind_times ?? source.usedUnbindTimes),
    deviceBindCount: toFiniteNumber(source.device_bind_count ?? source.deviceBindCount),
    maxDeviceCount: toFiniteNumber(source.max_device_count ?? source.maxDeviceCount),
    deviceBindingStatus: source.device_binding_status ?? source.deviceBindingStatus ?? '',
    deviceBindingSummary: source.device_binding_summary ?? source.deviceBindingSummary ?? '',
  };
}

// 创建/初始化：buildUnboundCredentialRecord的具体业务逻辑。
/**
 * @param {Record<string, any>} [existing]
 * @param {Record<string, any>} [binding]
 */
function buildUnboundCredentialRecord(existing = {}, { key, deviceId } = {}) {
  return {
    key: key || existing.key || '',
  };
}

// 处理：toBoolean的具体业务逻辑。
function toBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'enabled'].includes(text)) return true;
    if (['0', 'false', 'no', 'off', 'disabled'].includes(text)) return false;
  }
  return fallback;
}

module.exports = {
  buildUnboundCredentialRecord,
  normalizeLicenseBinding,
  persistSavedLicenseKeySafe,
  readStoreConfigSafe,
  saveLicenseCredentialsSafe,
  sanitizeUserFacingMessage,
  toBoolean,
  toFiniteNumber,
  writeStoreConfigSafe,
};
