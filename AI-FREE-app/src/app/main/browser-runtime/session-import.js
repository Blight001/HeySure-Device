const MAX_COOKIES = 2048;
const MAX_STORAGE_ORIGINS = 64;
const MAX_STORAGE_KEYS = 4096;
const MAX_SESSION_IMPORT_BYTES = 3 * 1024 * 1024;

class SessionImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SessionImportError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SessionImportError(code, message);
}

function parseHttpUrl(value, code, label) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); } catch (_) {
    fail(code, `${label} 不是有效 URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    fail(code, `${label} 只允许无凭据的 HTTP/HTTPS URL`);
  }
  return parsed;
}

function normalizeHost(value) {
  return String(value || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
}

function hostsRelated(left, right) {
  const a = normalizeHost(left);
  const b = normalizeHost(right);
  return !!a && !!b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));
}

function normalizeSameSite(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/-/g, '_');
  if (!normalized || normalized === 'unspecified') return 'unspecified';
  if (normalized === 'none' || normalized === 'no_restriction') return 'no_restriction';
  if (normalized === 'lax' || normalized === 'strict') return normalized;
  fail('SESSION_COOKIE_INVALID', `不支持的 Cookie sameSite: ${value}`);
}

function normalizeExpiry(cookie) {
  const raw = cookie.expires ?? cookie.expirationDate ?? cookie.expiration_date;
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'number' || /^\d+(\.\d+)?$/.test(String(raw).trim())) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0) fail('SESSION_COOKIE_INVALID', 'Cookie expires 无效');
    return seconds > 10_000_000_000 ? seconds / 1000 : seconds;
  }
  const milliseconds = Date.parse(String(raw));
  if (!Number.isFinite(milliseconds)) fail('SESSION_COOKIE_INVALID', 'Cookie expires 无效');
  return milliseconds / 1000;
}

function firstSessionValue(source, fields, fallback = '') {
  for (const field of fields) {
    const value = source[field];
    if (value !== undefined && value !== null) return value;
  }
  return fallback;
}

function validateCookieScope(name, domain, cookieUrl, targetUrl) {
  if (!hostsRelated(cookieUrl.hostname, targetUrl.hostname)) {
    fail('SESSION_DOMAIN_FORBIDDEN', `Cookie ${name} 的 URL 与 targetUrl 不相关`);
  }
  if (domain && (!hostsRelated(domain, targetUrl.hostname) || !hostsRelated(domain, cookieUrl.hostname))) {
    fail('SESSION_DOMAIN_FORBIDDEN', `Cookie ${name} 的 domain 与 targetUrl 不相关`);
  }
}

function normalizeCookieDomain(cookie, domain) {
  if (!domain) return '';
  return String(firstSessionValue(cookie, ['domain', 'Domain'])).trim().startsWith('.') ? `.${domain}` : domain;
}

function normalizeCookie(cookie, targetUrl) {
  if (!cookie || typeof cookie !== 'object') fail('SESSION_COOKIE_INVALID', 'Cookie 必须是对象');
  const name = String(firstSessionValue(cookie, ['name', 'Name'])).trim();
  if (!name || name.length > 4096) fail('SESSION_COOKIE_INVALID', 'Cookie 缺少有效 name');
  const value = String(firstSessionValue(cookie, ['value', 'Value']));
  const domain = normalizeHost(firstSessionValue(cookie, ['domain', 'Domain']));
  const cookieUrl = cookie.url
    ? parseHttpUrl(cookie.url, 'SESSION_COOKIE_INVALID', `Cookie ${name} 的 url`)
    : new URL(targetUrl.href);
  validateCookieScope(name, domain, cookieUrl, targetUrl);
  const normalized = {
    name,
    value,
    url: cookieUrl.href,
    domain: normalizeCookieDomain(cookie, domain),
    path: String(firstSessionValue(cookie, ['path', 'Path'], '/')).trim() || '/',
    secure: cookie.secure === true || cookie.Secure === true,
    httpOnly: cookie.httpOnly === true || cookie.httponly === true || cookie.HttpOnly === true,
    sameSite: normalizeSameSite(firstSessionValue(cookie, ['sameSite', 'same_site', 'SameSite'])),
  };
  const expires = normalizeExpiry(cookie);
  if (expires !== undefined) normalized.expires = expires;
  return normalized;
}

function normalizeStorageMap(value, label, counter) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) fail('SESSION_STORAGE_INVALID', `${label} 必须是对象`);
  const result = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (++counter.count > MAX_STORAGE_KEYS) fail('SESSION_STORAGE_LIMIT', 'Storage key 数量超过限制');
    const normalizedKey = String(key);
    const normalizedValue = String(rawValue ?? '');
    if (normalizedKey.length > 16 * 1024 || normalizedValue.length > 1024 * 1024) {
      fail('SESSION_STORAGE_LIMIT', `${label} 的 key/value 超过限制`);
    }
    result[normalizedKey] = normalizedValue;
  }
  return result;
}

function normalizeStorageEntry(entry, targetUrl, counter) {
  if (!entry || typeof entry !== 'object') fail('SESSION_STORAGE_INVALID', 'Storage 条目必须是对象');
  const parsed = parseHttpUrl(entry.origin || entry.url, 'SESSION_ORIGIN_INVALID', 'Storage origin');
  if (parsed.origin !== String(entry.origin || parsed.origin).replace(/\/$/, '') && entry.origin) {
    fail('SESSION_ORIGIN_INVALID', 'Storage origin 必须是纯 origin，不能包含路径');
  }
  if (!hostsRelated(parsed.hostname, targetUrl.hostname)) {
    fail('SESSION_ORIGIN_FORBIDDEN', `Storage origin ${parsed.origin} 与 targetUrl 不相关`);
  }
  return {
    origin: parsed.origin,
    localStorage: normalizeStorageMap(entry.localStorage, 'localStorage', counter),
    sessionStorage: normalizeStorageMap(entry.sessionStorage, 'sessionStorage', counter),
  };
}

function collectSessionEntries(entries, normalizeEntry, skippedCode) {
  const values = [];
  let skipped = 0;
  for (const entry of entries) {
    try {
      values.push(normalizeEntry(entry));
    } catch (error) {
      if (error?.code !== skippedCode) throw error;
      skipped += 1;
    }
  }
  return { values, skipped };
}

function prepareSessionImport(input = {}) {
  const targetUrl = parseHttpUrl(input.targetUrl, 'SESSION_TARGET_URL_INVALID', 'targetUrl');
  const rawCookies = input.cookies == null ? [] : input.cookies;
  const rawStorage = input.browserStorage == null ? [] : input.browserStorage;
  if (!Array.isArray(rawCookies)) fail('SESSION_COOKIE_INVALID', 'cookies 必须是数组');
  if (!Array.isArray(rawStorage)) fail('SESSION_STORAGE_INVALID', 'browserStorage 必须是数组');
  if (rawCookies.length > MAX_COOKIES) fail('SESSION_COOKIE_LIMIT', 'Cookie 数量超过限制');
  if (rawStorage.length > MAX_STORAGE_ORIGINS) fail('SESSION_STORAGE_LIMIT', 'Storage origin 数量超过限制');
  const counter = { count: 0 };
  const cookieResult = collectSessionEntries(rawCookies,
    (cookie) => normalizeCookie(cookie, targetUrl), 'SESSION_DOMAIN_FORBIDDEN');
  const storageResult = collectSessionEntries(rawStorage,
    (entry) => normalizeStorageEntry(entry, targetUrl, counter), 'SESSION_ORIGIN_FORBIDDEN');
  const prepared = {
    targetUrl: targetUrl.href,
    cookies: cookieResult.values,
    browserStorage: storageResult.values,
    skippedCookies: cookieResult.skipped,
    skippedStorageOrigins: storageResult.skipped,
  };
  const bytes = Buffer.byteLength(JSON.stringify(prepared), 'utf8');
  if (bytes > MAX_SESSION_IMPORT_BYTES) fail('SESSION_IMPORT_TOO_LARGE', '会话导入数据超过限制');
  return prepared;
}

module.exports = {
  MAX_SESSION_IMPORT_BYTES,
  SessionImportError,
  hostsRelated,
  prepareSessionImport,
};
