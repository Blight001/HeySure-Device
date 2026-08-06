'use strict';

const {
  getCurrentAccountTypeLabel,
  inferCurrentAccountTypeFromLabel,
  normalizePositiveNumber,
  normalizeTimeValueToMs,
  resolveCurrentAccountType,
} = require('../../utils/normalizers');
const { pickFirstText, pickFirstValue } = require('../../utils/license-response');

function responseRoots(source) {
  return [source, source?.data, source?.result, source?.payload]
    .filter((item) => item && typeof item === 'object');
}

function collectResponseValues(source, keys, includeRefreshInfo = false) {
  const values = [];
  for (const root of responseRoots(source)) {
    for (const key of keys) values.push(root[key]);
    if (!includeRefreshInfo) continue;
    for (const refresh of [root.refresh_info, root.refreshInfo]) {
      if (!refresh || typeof refresh !== 'object') continue;
      for (const key of keys) values.push(refresh[key]);
    }
  }
  return values;
}

function pickResponseValue(source, keys, includeRefreshInfo = false) {
  return pickFirstValue(...collectResponseValues(source, keys, includeRefreshInfo));
}

function presentOrUndefined(value) {
  return value === null || value === undefined || value === '' ? undefined : value;
}

function emptyRecycleTimeInfo() {
  return { serverRecycleTime: '', serverRecycleTimeTs: null, serverRecycleTimeIso: '' };
}

function extractCurrentAccountTypeInfo(source) {
  if (!source || typeof source !== 'object') {
    return { currentAccountType: '', currentAccountTypeLabel: '' };
  }
  const rawType = pickFirstText(...collectResponseValues(
    source,
    ['current_account_type', 'currentAccountType'],
  ));
  const rawLabel = pickFirstText(...collectResponseValues(
    source,
    ['current_account_type_label', 'currentAccountTypeLabel'],
  ));
  const currentAccountType = resolveCurrentAccountType(rawType, rawLabel);
  const normalizedLabelType = inferCurrentAccountTypeFromLabel(rawLabel);
  const mismatchedLabel = normalizedLabelType
    && currentAccountType
    && normalizedLabelType !== currentAccountType;
  const currentAccountTypeLabel = mismatchedLabel
    ? getCurrentAccountTypeLabel(currentAccountType)
    : (String(rawLabel || '').trim() || getCurrentAccountTypeLabel(currentAccountType));
  return { currentAccountType, currentAccountTypeLabel };
}

function resolveRelativeRecycleTime(remainingSeconds, remainingMinutes) {
  const seconds = normalizePositiveNumber(remainingSeconds);
  const minutes = normalizePositiveNumber(remainingMinutes);
  const durationMs = seconds
    ? Math.floor(seconds * 1000)
    : (minutes ? Math.floor(minutes * 60 * 1000) : 0);
  return {
    seconds,
    minutes,
    timestamp: durationMs ? Date.now() + durationMs : null,
  };
}

function extractServerRecycleTimeInfo(source) {
  if (!source || typeof source !== 'object') return emptyRecycleTimeInfo();
  const explicit = pickResponseValue(source, ['server_recycle_time', 'serverRecycleTime']);
  const nextRefresh = pickResponseValue(source, ['next_refresh_at', 'nextRefreshAt'], true);
  const remainingSeconds = pickResponseValue(source, ['remaining_seconds', 'remainingSeconds'], true);
  const remainingMinutes = pickResponseValue(source, ['remaining_minutes', 'remainingMinutes'], true);
  const relative = resolveRelativeRecycleTime(remainingSeconds, remainingMinutes);
  const serverRecycleTimeTs = normalizeTimeValueToMs(explicit)
    || normalizeTimeValueToMs(nextRefresh)
    || relative.timestamp
    || null;
  const rawValue = explicit
    ?? nextRefresh
    ?? (relative.seconds ? String(relative.seconds) : null)
    ?? (relative.minutes ? String(relative.minutes * 60) : null);
  const formatted = serverRecycleTimeTs ? new Date(serverRecycleTimeTs).toISOString() : '';
  const serverRecycleTime = serverRecycleTimeTs
    ? (typeof rawValue === 'string' && rawValue.trim() ? rawValue.trim() : formatted)
    : '';
  return { serverRecycleTime, serverRecycleTimeTs, serverRecycleTimeIso: formatted };
}

function extractServerRecycleDebugInfo(source) {
  if (!source || typeof source !== 'object') {
    return {
      serverRecycleTime: undefined,
      serverRecycleTimeIso: undefined,
      aiAccountExpiryTime: undefined,
      nextRefreshAt: undefined,
      remainingSeconds: undefined,
      remainingMinutes: undefined,
    };
  }
  const recycle = extractServerRecycleTimeInfo(source);
  return {
    serverRecycleTime: recycle.serverRecycleTime || undefined,
    serverRecycleTimeIso: recycle.serverRecycleTimeIso || undefined,
    aiAccountExpiryTime: presentOrUndefined(pickResponseValue(
      source,
      ['ai_account_expiry_time', 'aiAccountExpiryTime'],
    )),
    nextRefreshAt: presentOrUndefined(pickResponseValue(
      source,
      ['next_refresh_at', 'nextRefreshAt'],
      true,
    )),
    remainingSeconds: presentOrUndefined(pickResponseValue(
      source,
      ['remaining_seconds', 'remainingSeconds'],
      true,
    )),
    remainingMinutes: presentOrUndefined(pickResponseValue(
      source,
      ['remaining_minutes', 'remainingMinutes'],
      true,
    )),
  };
}

module.exports = {
  collectResponseValues,
  extractCurrentAccountTypeInfo,
  extractServerRecycleDebugInfo,
  extractServerRecycleTimeInfo,
};
