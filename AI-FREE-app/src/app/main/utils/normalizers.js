function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function firstDefinedValue(source, fields) {
  for (const field of fields) {
    if (source[field] !== undefined && source[field] !== null) return source[field];
  }
  return undefined;
}

function normalizePositiveNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

function normalizeTimeValueToMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return normalizeDateToMs(value);
  if (typeof value === 'number') return normalizeNumericTimeToMs(value);
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return normalizeNumericTextTimeToMs(text);
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeDateToMs(value) {
  const timestamp = value.getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizeNumericTimeToMs(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  return value > 1e12 ? Math.floor(value) : Math.floor(value * 1000);
}

function normalizeNumericTextTimeToMs(text) {
  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  if (text.length >= 13 || number > 1e12) return Math.floor(number);
  return Math.floor(number * 1000);
}

function normalizeCurrentAccountType(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (['shared', 'temporary', 'temp', 'midnight_clear', 'clear_at_24', '24h', '24-hour'].includes(text)) return 'shared';
  if (['one_time', 'one-time', 'permanent', 'long_term', 'long-term', 'longterm', 'binding', 'bound'].includes(text)) return 'one_time';
  if (['disposable', 'throwaway', 'single_use', 'single-use'].includes(text)) return 'disposable';
  return text;
}

function inferCurrentAccountTypeFromLabel(label) {
  const text = String(label || '').trim();
  if (!text) return '';
  if (text.includes('永久') || text.includes('长久') || text.includes('一次')) return 'one_time';
  if (text.includes('绑定')) return 'one_time';
  if (text.includes('次抛') || text.includes('disposable') || text.includes('throwaway')) return 'disposable';
  if (text.includes('循环') || text.includes('24点') || text.includes('清空') || text.includes('临时')) return 'shared';
  return '';
}

function resolveCurrentAccountType(rawType, rawLabel) {
  return normalizeCurrentAccountType(rawType) || inferCurrentAccountTypeFromLabel(rawLabel) || '';
}

function getCurrentAccountTypeLabel(value) {
  const type = normalizeCurrentAccountType(value);
  if (type === 'shared') return '循环账号';
  if (type === 'one_time') return '绑定账号';
  if (type === 'disposable') return '次抛账号';
  return '';
}

/** @param {Record<string, any>} [source] */
function normalizeLicenseUsage(source = {}) {
  if (!source || typeof source !== 'object') return null;

  const maxUsageTimes = toFiniteNumber(firstDefinedValue(source, ['max_usage_times', 'maxUsageTimes']));
  const usedUsageTimes = toFiniteNumber(firstDefinedValue(source, ['used_usage_times', 'usedUsageTimes']));
  const remainingUsageTimes = toFiniteNumber(firstDefinedValue(source, ['remaining_usage_times', 'remainingUsageTimes']));
  const expireAt = String(firstDefinedValue(source, ['expire_at', 'expireAt', 'cardExpiryDate', 'expiryDate']) || '').trim();
  const daysLeft = firstDefinedValue(source, ['days_left', 'daysLeft']);
  const expiresInSeconds = firstDefinedValue(source, ['expires_in_seconds', 'expiresInSeconds']);

  if (!hasLicenseUsageValues({ maxUsageTimes, usedUsageTimes, remainingUsageTimes,
    expireAt, daysLeft, expiresInSeconds })) return null;

  const normalized = {
    max_usage_times: maxUsageTimes,
    used_usage_times: usedUsageTimes,
    remaining_usage_times: remainingUsageTimes,
  };

  if (expireAt) normalized.expire_at = expireAt;
  if (daysLeft !== undefined) normalized.days_left = daysLeft;
  if (expiresInSeconds !== undefined) normalized.expires_in_seconds = expiresInSeconds;
  return normalized;
}

function hasLicenseUsageValues(values) {
  return values.maxUsageTimes !== null || values.usedUsageTimes !== null
    || values.remainingUsageTimes !== null || Boolean(values.expireAt)
    || values.daysLeft !== undefined || values.expiresInSeconds !== undefined;
}

module.exports = {
  getCurrentAccountTypeLabel,
  inferCurrentAccountTypeFromLabel,
  normalizeLicenseUsage,
  normalizePositiveNumber,
  normalizeTimeValueToMs,
  resolveCurrentAccountType,
  toFiniteNumber,
};
