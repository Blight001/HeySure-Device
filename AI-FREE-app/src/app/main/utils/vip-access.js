const FREE_BROWSER_WINDOW_LIMIT = 5;
const VIP_VERIFICATION_MAX_AGE_MS = 10 * 60 * 1000;
const VIP_CLOCK_SKEW_MS = 60 * 1000;

function parseVipExpiry(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const parsed = Date.parse(text.includes('T') ? text : text.replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function collectVipSources(input = {}) {
  /** @type {Record<string, any>} */
  const source = input && typeof input === 'object' ? input : {};
  const candidates = [
    source.validation?.result,
    source.validation,
    source.result,
    source,
    source.account,
    source.result?.account,
  ];
  return candidates.filter((item) => item && typeof item === 'object');
}

function isRecentVipVerification(verification, now) {
  const verifiedAt = Date.parse(String(verification?.vip_verified_at || ''));
  return {
    verifiedAt,
    serverVerified: Number.isFinite(verifiedAt) && verifiedAt <= now + VIP_CLOCK_SKEW_MS
      && now - verifiedAt <= VIP_VERIFICATION_MAX_AGE_MS,
  };
}

function resolveVipStatus(sources) {
  for (const source of sources) {
    const fields = ['is_vip', 'isVip', 'vip_active', 'vipActive'];
    if (!fields.some((key) => Object.prototype.hasOwnProperty.call(source, key))) continue;
    return fields.some((key) => source[key] === true || Number(source[key]) === 1);
  }
  return false;
}

function resolveVipExpiryDate(sources) {
  for (const source of sources) {
    const value = String(source.vip_expiry_date || source.vipExpiryDate || '').trim();
    if (value) return value;
  }
  return '';
}

function isVipExpiryActive(expiryDate, now) {
  const timestamp = parseVipExpiry(expiryDate);
  return timestamp === null || (Number.isFinite(timestamp) && timestamp > now);
}

function resolveVipAccess(input = {}, now = Date.now()) {
  const sources = collectVipSources(input);
  const verification = sources.find((source) => source.vip_server_verified === true);
  const { verifiedAt, serverVerified } = isRecentVipVerification(verification, now);
  const enabled = resolveVipStatus(sources);
  const expiryDate = resolveVipExpiryDate(sources);
  const active = serverVerified && enabled && isVipExpiryActive(expiryDate, now);
  return {
    isVip: active,
    vipActive: active,
    vipExpiryDate: expiryDate,
    permanent: active && !expiryDate,
    serverVerified,
    verifiedAt: Number.isFinite(verifiedAt) ? new Date(verifiedAt).toISOString() : '',
  };
}

function markVipServerVerified(source = {}, verifiedAt = Date.now()) {
  const value = source && typeof source === 'object' ? source : {};
  return {
    ...value,
    vip_server_verified: true,
    vip_verified_at: new Date(verifiedAt).toISOString(),
  };
}

function clearVipServerVerification(source = {}) {
  /** @type {Record<string, any>} */
  const value = source && typeof source === 'object' ? source : {};
  const clear = (item) => ({
    ...(item && typeof item === 'object' ? item : {}),
    is_vip: false,
    isVip: false,
    vip_active: false,
    vipActive: false,
    vip_server_verified: false,
    vip_verified_at: '',
  });
  return {
    ...clear(value),
    ...(value.result && typeof value.result === 'object' ? { result: clear(value.result) } : {}),
    ...(value.account && typeof value.account === 'object' ? { account: clear(value.account) } : {}),
  };
}

function readStoredVipAccess(readStoreConfigSafe) {
  try {
    const store = typeof readStoreConfigSafe === 'function' ? readStoreConfigSafe() : {};
    return resolveVipAccess(store?.userCredentials || {});
  } catch (_) {
    return resolveVipAccess({});
  }
}

function createVipRequiredResult(feature = '此功能') {
  return {
    ok: false,
    vipRequired: true,
    code: 'VIP_REQUIRED',
    message: `${feature}仅限 VIP 用户，请前往个人中心开通 VIP`,
  };
}

module.exports = {
  FREE_BROWSER_WINDOW_LIMIT,
  VIP_VERIFICATION_MAX_AGE_MS,
  clearVipServerVerification,
  createVipRequiredResult,
  markVipServerVerified,
  parseVipExpiry,
  readStoredVipAccess,
  resolveVipAccess,
};
