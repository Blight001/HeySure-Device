'use strict';

const { normalizeBrowserStorageEntries } = require('../../utils/browser-storage');
const { firstNonNull, firstText } = require('../../../shared/safe-values');

function isTruthyFlag(value) {
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

function applyCookieExpiration(cookie, expiration) {
  if (expiration === undefined || expiration === null || expiration === '') return;
  const value = Number(expiration);
  if (Number.isFinite(value)) cookie.expirationDate = value;
}

function normalizeImportedCookieEntry(source, defaultUrl) {
  let entry = source;
  if (!entry) return null;
  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    const separator = trimmed.indexOf('=');
    if (separator <= 0) return null;
    entry = { name: trimmed.slice(0, separator).trim(), value: trimmed.slice(separator + 1).trim() };
  }
  if (typeof entry !== 'object') return null;
  const name = firstNonNull(entry.name, entry.Name, entry.key, entry.Key);
  if (!name) return null;
  const cookie = {
    ...entry,
    name: String(name),
    value: firstText(firstNonNull(entry.value, entry.Value, entry.val, entry.Val)),
    path: firstText(firstNonNull(entry.path, entry.Path), '/'),
  };
  const domain = firstNonNull(entry.domain, entry.Domain);
  if (domain) cookie.domain = String(domain);
  const url = firstNonNull(entry.url, entry.URL);
  if (url) cookie.url = String(url);
  else if (cookie.domain) cookie.url = `https://${String(cookie.domain).replace(/^\./, '')}/`;
  else if (defaultUrl) cookie.url = defaultUrl;
  const expiration = firstNonNull(entry.expirationDate, entry.expires, entry.Expires, entry.expiresAt, entry.expiry);
  applyCookieExpiration(cookie, expiration);
  const sameSiteRaw = firstText(firstNonNull(entry.sameSite, entry.samesite)).trim().toLowerCase();
  const sameSite = sameSiteRaw === 'none' ? 'no_restriction' : sameSiteRaw;
  if (['no_restriction', 'lax', 'strict'].includes(sameSite)) cookie.sameSite = sameSite;
  cookie.secure = [entry.secure, entry.Secure, entry.isSecure, entry.is_secure].some(isTruthyFlag);
  cookie.httpOnly = [entry.httpOnly, entry.httponly, entry.HttpOnly, entry.http_only].some(isTruthyFlag);
  return cookie;
}

function firstArray(...values) {
  return values.find(Array.isArray) || null;
}

function parseJsonAccountContent(parsed, defaultUrl) {
  if (Array.isArray(parsed)) {
    return { cookies: parsed.map((item) => normalizeImportedCookieEntry(item, defaultUrl)).filter(Boolean), browserStorage: [] };
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
  const cookiesSource = firstArray(parsed.cookies, data.cookies);
  const browserStorageSource = firstArray(parsed.browserStorage, data.browserStorage);
  if (cookiesSource || browserStorageSource) {
    return {
      cookies: (cookiesSource || []).map((item) => normalizeImportedCookieEntry(item, defaultUrl)).filter(Boolean),
      browserStorage: normalizeBrowserStorageEntries(browserStorageSource || []),
    };
  }
  const fallback = firstArray(data, parsed.cookie);
  if (fallback) {
    return { cookies: fallback.map((item) => normalizeImportedCookieEntry(item, defaultUrl)).filter(Boolean), browserStorage: [] };
  }
  return {
    cookies: Object.entries(parsed).map(([name, value]) => normalizeImportedCookieEntry({ name, value }, defaultUrl)).filter(Boolean),
    browserStorage: [],
  };
}

function parseNetscapeCookies(lines, defaultUrl) {
  const cookies = [];
  for (let line of lines) {
    let httpOnly = false;
    if (line.startsWith('#HttpOnly_')) {
      httpOnly = true;
      line = line.slice('#HttpOnly_'.length);
    }
    if (!line || line.startsWith('#')) continue;
    const columns = line.split(/\t+/);
    if (columns.length < 7) continue;
    const [domain, , cookiePath, secureFlag, expires, name, ...valueParts] = columns;
    const cookie = normalizeImportedCookieEntry({
      domain,
      path: cookiePath,
      secure: /^TRUE$/i.test(String(secureFlag)),
      expirationDate: expires,
      name,
      value: valueParts.join('\t'),
      httpOnly,
    }, defaultUrl);
    if (cookie) cookies.push(cookie);
  }
  return cookies;
}

function parseHeaderCookies(text, defaultUrl) {
  const attributes = new Set(['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly']);
  const cookies = [];
  for (const token of text.split(/;\s*/)) {
    const separator = token.indexOf('=');
    if (separator <= 0) continue;
    const name = token.slice(0, separator).trim();
    if (!name || attributes.has(name.toLowerCase())) continue;
    const cookie = normalizeImportedCookieEntry({ name, value: token.slice(separator + 1).trim() }, defaultUrl);
    if (cookie) cookies.push(cookie);
  }
  return cookies;
}

function parseImportedAccountContent(content, defaultUrl) {
  const text = String(content || '').replace(/^\uFEFF/, '').trim();
  if (!text) return { cookies: [], browserStorage: [] };
  try {
    const parsed = parseJsonAccountContent(JSON.parse(text), defaultUrl);
    if (parsed) return parsed;
  } catch (_) {}
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const netscapeCookies = parseNetscapeCookies(lines, defaultUrl);
  return { cookies: netscapeCookies.length ? netscapeCookies : parseHeaderCookies(text, defaultUrl), browserStorage: [] };
}

function parseImportedCookieContent(content, defaultUrl) {
  return parseImportedAccountContent(content, defaultUrl).cookies;
}

function inferImportedTargetUrl(imported, defaultUrl) {
  const source = imported && typeof imported === 'object' ? imported : {};
  for (const entry of Array.isArray(source.browserStorage) ? source.browserStorage : []) {
    const target = firstText(entry && entry.url, entry && entry.origin).trim();
    if (target) return target;
  }
  for (const cookie of Array.isArray(source.cookies) ? source.cookies : []) {
    const url = firstText(cookie && cookie.url).trim();
    if (url) return url;
    const domain = firstText(cookie && cookie.domain).trim().replace(/^\./, '');
    if (domain) return `https://${domain}/`;
  }
  return firstText(defaultUrl).trim();
}

function isPlaceholderTargetUrl(rawUrl) {
  const text = String(rawUrl || '').trim();
  if (!text || text.toLowerCase() === 'about:blank') return true;
  try {
    const host = String(new URL(text).hostname || '').toLowerCase();
    return host === 'google.com' || host.endsWith('.google.com') || host === 'google.cn' || host.endsWith('.google.cn');
  } catch (_) {
    return false;
  }
}

module.exports = {
  inferImportedTargetUrl,
  isPlaceholderTargetUrl,
  normalizeImportedCookieEntry,
  parseImportedAccountContent,
  parseImportedCookieContent,
};
