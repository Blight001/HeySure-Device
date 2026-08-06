function getCookieTargetUrl(cookie) {
  const explicit = String(cookie?.url || '').trim();
  if (explicit || !cookie?.domain) return explicit;
  return `https://${String(cookie.domain).replace(/^\./, '')}/`;
}

function groupCookiesByOrigin(rawCookies) {
  const groups = new Map();
  for (const cookie of Array.isArray(rawCookies) ? rawCookies : []) {
    const targetUrl = getCookieTargetUrl(cookie);
    try {
      const parsed = new URL(targetUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
      const cookies = groups.get(parsed.origin) || [];
      cookies.push({ ...cookie, url: targetUrl });
      groups.set(parsed.origin, cookies);
    } catch (_) {}
  }
  return groups;
}

module.exports = { groupCookiesByOrigin };
