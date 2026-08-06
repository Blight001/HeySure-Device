'use strict';

const { normalizeLicenseUsage } = require('../../utils/normalizers');
const { markVipServerVerified } = require('../../utils/vip-access');
const { callOptional, firstNonNull, firstNonNullOr, firstText } = require('../../../shared/safe-values');

function getRuntimeCache(deps) {
  return callOptional(deps, 'getRuntimeLicenseCache');
}

function normalizeSnapshotUsage(snapshot) {
  const usageSource = snapshot.licenseUsage && typeof snapshot.licenseUsage === 'object'
    ? snapshot.licenseUsage
    : snapshot.result;
  return normalizeLicenseUsage({
    ...snapshot,
    ...(usageSource && typeof usageSource === 'object' ? usageSource : {}),
  });
}

function snapshotMatchesCredentials(snapshot, key, deviceId) {
  if (key && snapshot.key && firstText(snapshot.key).trim() !== key) return false;
  if (deviceId && snapshot.deviceId && firstText(snapshot.deviceId).trim() !== deviceId) return false;
  return true;
}

function getStoredLicenseUsage(deps, key, deviceId) {
  try {
    const cache = getRuntimeCache(deps);
    if (!cache || typeof cache.getSnapshot !== 'function') return null;
    const snapshot = cache.getSnapshot() || {};
    const normalizedKey = firstText(key).trim();
    const normalizedDeviceId = firstText(deviceId).trim();
    if (!snapshotMatchesCredentials(snapshot, normalizedKey, normalizedDeviceId)) return null;
    const normalizedUsage = normalizeSnapshotUsage(snapshot);
    if (!normalizedUsage) return null;
    return {
      ...normalizedUsage,
      key: firstText(snapshot.key, normalizedKey),
      deviceId: firstText(snapshot.deviceId, normalizedDeviceId),
    };
  } catch (error) {
    console.warn('[LicenseUsage] 读取运行时次数失败:', error?.message || error);
    return null;
  }
}

function resolveUsageAccountType(payload) {
  return {
    currentAccountType: firstText(
      payload.currentAccountType, payload.current_account_type, payload.accountType, payload.account_type,
    ).trim(),
    currentAccountTypeLabel: firstText(
      payload.currentAccountTypeLabel, payload.current_account_type_label,
      payload.accountTypeLabel, payload.account_type_label,
    ).trim(),
  };
}

function buildUsageValidationState(key, deviceId, payload) {
  const normalizedUsage = /** @type {any} */ (normalizeLicenseUsage(payload) || {});
  return {
    key: firstText(key).trim(),
    deviceId: firstText(deviceId).trim(),
    validated: true,
    bound: true,
    licenseValidated: true,
    result: payload,
    licenseUsage: payload,
    maxUsageTimes: firstNonNullOr(null, normalizedUsage.max_usage_times, payload.max_usage_times, payload.maxUsageTimes),
    usedUsageTimes: firstNonNullOr(null, normalizedUsage.used_usage_times, payload.used_usage_times, payload.usedUsageTimes),
    remainingUsageTimes: firstNonNullOr(
      null, normalizedUsage.remaining_usage_times, payload.remaining_usage_times, payload.remainingUsageTimes,
    ),
    accountType: firstText(payload.accountType, payload.account_type),
    accountTypeLabel: firstText(payload.accountTypeLabel, payload.account_type_label),
    ...resolveUsageAccountType(payload),
    message: firstText(payload.message, payload.msg),
  };
}

function saveLicenseUsageSnapshot(deps, input = {}) {
  try {
    const cache = getRuntimeCache(deps);
    if (!cache || typeof cache.setValidationState !== 'function') return null;
    const payload = markVipServerVerified(input.source && typeof input.source === 'object' ? input.source : {});
    const nextState = cache.setValidationState(buildUsageValidationState(input.key, input.deviceId, payload));
    try {
      deps.sendToSide('license-usage-updated', nextState);
    } catch (error) {
      console.warn('[LicenseUsage] 通知侧边栏失败:', error?.message || error);
    }
    return nextState;
  } catch (error) {
    console.warn('[LicenseUsage] 保存运行时次数快照失败:', error?.message || error);
    return null;
  }
}

function deriveNextUsage(normalizedUsage) {
  const remaining = Number(normalizedUsage.remaining_usage_times);
  const max = Number(normalizedUsage.max_usage_times);
  const used = Number(normalizedUsage.used_usage_times);
  const currentRemaining = Number.isFinite(remaining)
    ? remaining
    : (Number.isFinite(max) && Number.isFinite(used) ? max - used : null);
  const nextUsage = {
    ...normalizedUsage,
    remaining_usage_times: currentRemaining === null ? null : Math.max(0, currentRemaining - 1),
  };
  if (Number.isFinite(used)) nextUsage.used_usage_times = used + 1;
  return nextUsage;
}

function buildConsumedValidationState(snapshot, key, deviceId, nextUsage) {
  return {
    key: firstText(key, snapshot.key),
    deviceId: firstText(deviceId, snapshot.deviceId),
    validated: true,
    bound: true,
    licenseValidated: true,
    result: firstNonNull(snapshot.result, snapshot.licenseUsage, {}),
    licenseUsage: nextUsage,
    maxUsageTimes: firstNonNullOr(null, nextUsage.max_usage_times),
    usedUsageTimes: firstNonNullOr(null, nextUsage.used_usage_times),
    remainingUsageTimes: firstNonNullOr(null, nextUsage.remaining_usage_times),
    accountType: firstText(snapshot.accountType, snapshot.account_type),
    accountTypeLabel: firstText(snapshot.accountTypeLabel, snapshot.account_type_label),
    currentAccountType: firstText(
      snapshot.currentAccountType, snapshot.current_account_type, snapshot.accountType, snapshot.account_type,
    ),
    currentAccountTypeLabel: firstText(
      snapshot.currentAccountTypeLabel, snapshot.current_account_type_label,
      snapshot.accountTypeLabel, snapshot.account_type_label,
    ),
    message: firstText(snapshot.message),
  };
}

function consumeLocalLicenseUsage(deps, options = {}) {
  try {
    const cache = getRuntimeCache(deps);
    if (!cache || typeof cache.getSnapshot !== 'function' || typeof cache.setValidationState !== 'function') return null;
    const snapshot = cache.getSnapshot() || {};
    const key = firstText(options.key, snapshot.key).trim();
    const deviceId = firstText(options.deviceId, snapshot.deviceId).trim();
    if (!snapshotMatchesCredentials(snapshot, key, deviceId)) return null;
    const normalizedUsage = normalizeSnapshotUsage(snapshot);
    if (!normalizedUsage) return null;
    const nextUsage = deriveNextUsage(normalizedUsage);
    return cache.setValidationState(buildConsumedValidationState(snapshot, key, deviceId, nextUsage));
  } catch (error) {
    console.warn('[LicenseUsage] 消耗运行时次数失败:', error?.message || error);
    return null;
  }
}

function createLicenseUsageStore(deps = {}) {
  return {
    consumeLocalLicenseUsage: (options) => consumeLocalLicenseUsage(deps, options),
    getStoredLicenseUsage: (key, deviceId) => getStoredLicenseUsage(deps, key, deviceId),
    saveLicenseUsageSnapshot: (input) => saveLicenseUsageSnapshot(deps, input),
  };
}

module.exports = { createLicenseUsageStore };
