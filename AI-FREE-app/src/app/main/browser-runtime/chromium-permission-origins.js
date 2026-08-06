'use strict';

function isLoopbackHostname(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value === 'localhost' || value === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(value);
}

function normalizePermissionOrigins(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  const origins = new Set();
  for (const entry of source) {
    try {
      const url = new URL(String(entry || '').trim());
      const secure = url.protocol === 'https:';
      const loopback = url.protocol === 'http:' && isLoopbackHostname(url.hostname);
      if ((!secure && !loopback) || url.username || url.password || url.pathname !== '/'
          || url.search || url.hash || url.hostname.includes('*')) continue;
      origins.add(url.origin);
    } catch (_) {}
  }
  return [...origins];
}

module.exports = { normalizePermissionOrigins };
