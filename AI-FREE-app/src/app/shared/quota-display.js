const QUOTA_DISPLAY_STORAGE_PREFIX = 'ai-free.quota-display-baseline.v1.';
const QUOTA_DISPLAY_NORMALIZED_FLAG = '__softwareQuotaNormalized';

function quotaDisplayFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function quotaDisplayCurrentScope() {
  if (typeof document === 'undefined') return 'local';
  const username = String(/** @type {HTMLInputElement | null} */ (document.getElementById('account-username-display'))?.value || '').trim();
  const deviceId = String(/** @type {HTMLInputElement | null} */ (document.getElementById('device-id'))?.value || '').trim();
  return `${username || 'anonymous'}|${deviceId || 'device'}`;
}

function quotaDisplayOptions(options = {}) {
  return {
    storage: options.storage || (typeof localStorage !== 'undefined' ? localStorage : null),
    scope: String(options.scope || quotaDisplayCurrentScope()),
  };
}

function quotaDisplayEmptyState() {
  return { version: 1, ai: null, traffic: null };
}

function quotaDisplayReadState(options = {}) {
  const { storage, scope } = quotaDisplayOptions(options);
  if (!storage) return quotaDisplayEmptyState();
  try {
    const parsed = JSON.parse(storage.getItem(QUOTA_DISPLAY_STORAGE_PREFIX + scope) || 'null');
    return {
      version: 1,
      ai: parsed?.ai && typeof parsed.ai === 'object' ? parsed.ai : null,
      traffic: parsed?.traffic && typeof parsed.traffic === 'object' ? parsed.traffic : null,
    };
  } catch (_) {
    return quotaDisplayEmptyState();
  }
}

function quotaDisplayWriteState(state, options = {}) {
  const { storage, scope } = quotaDisplayOptions(options);
  if (!storage) return false;
  try {
    storage.setItem(QUOTA_DISPLAY_STORAGE_PREFIX + scope, JSON.stringify({
      version: 1,
      ai: state?.ai || null,
      traffic: state?.traffic || null,
    }));
    return true;
  } catch (_) {
    return false;
  }
}

function quotaDisplayClearBaseline(kind, options) {
  const state = quotaDisplayReadState(options);
  state[kind] = null;
  quotaDisplayWriteState(state, options);
}

function quotaDisplayMarked(quota) {
  return { ...quota, [QUOTA_DISPLAY_NORMALIZED_FLAG]: true };
}

function quotaDisplayShouldSkip(quota) {
  return !quota || typeof quota !== 'object'
    || quota[QUOTA_DISPLAY_NORMALIZED_FLAG] === true || quota.unlimited === true;
}

function normalizeAIQuota(quota, options = {}) {
  if (quotaDisplayShouldSkip(quota)) return quota;
  const total = quotaDisplayFiniteNumber(quota.quota);
  const used = quotaDisplayFiniteNumber(quota.used);
  const baseline = quotaDisplayReadState(options).ai;
  if (!baseline) return quotaDisplayMarked(quota);
  const baseTotal = quotaDisplayFiniteNumber(baseline.total);
  const baseUsed = quotaDisplayFiniteNumber(baseline.used);
  if (total < baseTotal || used < baseUsed) {
    quotaDisplayClearBaseline('ai', options);
    return quotaDisplayMarked(quota);
  }
  const displayTotal = Math.max(0, total - baseTotal);
  const displayUsed = Math.max(0, used - baseUsed);
  return quotaDisplayMarked({ ...quota, quota: displayTotal, used: displayUsed, remaining: Math.max(0, displayTotal - displayUsed) });
}

function normalizeTrafficQuota(quota, options = {}) {
  if (quotaDisplayShouldSkip(quota)) return quota;
  const current = quotaDisplayTrafficValues(quota);
  const baseline = quotaDisplayReadState(options).traffic;
  if (!baseline) return quotaDisplayMarked(quota);
  const base = quotaDisplayTrafficBaselineValues(baseline);
  if (current.total < base.total || current.upload < base.upload || current.download < base.download) {
    quotaDisplayClearBaseline('traffic', options);
    return quotaDisplayMarked(quota);
  }
  return quotaDisplayBuildTrafficQuota(quota, current, base);
}

function quotaDisplayTrafficValues(quota) {
  return {
    total: quotaDisplayFiniteNumber(quota.quota_bytes),
    upload: quotaDisplayFiniteNumber(quota.upload_used_bytes),
    download: quotaDisplayFiniteNumber(quota.download_used_bytes),
  };
}

function quotaDisplayTrafficBaselineValues(baseline) {
  return {
    total: quotaDisplayFiniteNumber(baseline.total),
    upload: quotaDisplayFiniteNumber(baseline.upload),
    download: quotaDisplayFiniteNumber(baseline.download),
  };
}

function quotaDisplayBuildTrafficQuota(quota, current, base) {
  const upload = Math.max(0, current.upload - base.upload);
  const download = Math.max(0, current.download - base.download);
  const used = upload + download;
  const total = Math.max(0, current.total - base.total);
  const remaining = Math.max(0, total - used);
  return quotaDisplayMarked({
    ...quota,
    quota_bytes: total,
    upload_used_bytes: upload,
    download_used_bytes: download,
    used_bytes: used,
    remaining_bytes: remaining,
    exhausted: remaining <= 0,
  });
}

function recordAIResetAfterRedeem(quota, addedQuota, options = {}) {
  if (!quota || quota.unlimited === true) return normalizeAIQuota(quota, options);
  const total = quotaDisplayFiniteNumber(quota.quota);
  const used = quotaDisplayFiniteNumber(quota.used);
  const added = quotaDisplayFiniteNumber(addedQuota);
  if (added <= 0) return normalizeAIQuota(quota, options);
  const previousTotal = total - added;
  const previousDisplay = normalizeAIQuota({ ...quota, quota: previousTotal, remaining: Math.max(0, previousTotal - used) }, options);
  const remaining = quotaDisplayFiniteNumber(previousDisplay?.remaining, previousDisplay?.quota - previousDisplay?.used);
  if (remaining <= 0) quotaDisplaySaveAiBaseline(previousTotal, used, options);
  return normalizeAIQuota(quota, options);
}

function quotaDisplaySaveAiBaseline(total, used, options) {
  const state = quotaDisplayReadState(options);
  state.ai = { total, used, createdAt: Date.now() };
  quotaDisplayWriteState(state, options);
}

function recordTrafficResetAfterRedeem(quota, addedBytes, options = {}) {
  if (!quota || quota.unlimited === true) return normalizeTrafficQuota(quota, options);
  const values = quotaDisplayTrafficValues(quota);
  const added = quotaDisplayFiniteNumber(addedBytes);
  if (added <= 0) return normalizeTrafficQuota(quota, options);
  const previousTotal = values.total - added;
  const previousDisplay = normalizeTrafficQuota({
    ...quota,
    quota_bytes: previousTotal,
    remaining_bytes: Math.max(0, previousTotal - values.upload - values.download),
  }, options);
  const remaining = quotaDisplayFiniteNumber(previousDisplay?.remaining_bytes, previousDisplay?.quota_bytes - previousDisplay?.used_bytes);
  if (remaining <= 0) quotaDisplaySaveTrafficBaseline(previousTotal, values, options);
  return normalizeTrafficQuota(quota, options);
}

function quotaDisplaySaveTrafficBaseline(total, values, options) {
  const state = quotaDisplayReadState(options);
  state.traffic = { total, upload: values.upload, download: values.download, createdAt: Date.now() };
  quotaDisplayWriteState(state, options);
}

const quotaDisplayApi = { normalizeAIQuota, normalizeTrafficQuota, recordAIResetAfterRedeem, recordTrafficResetAfterRedeem };
if (typeof module === 'object' && module.exports) module.exports = quotaDisplayApi;
if (typeof globalThis !== 'undefined') globalThis.AiFreeQuotaDisplay = quotaDisplayApi;
