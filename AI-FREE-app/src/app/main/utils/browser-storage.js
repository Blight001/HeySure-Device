function normalizeBrowserStorageEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const origin = String(entry.origin ?? entry.Origin ?? '').trim();
  const url = String(entry.url ?? entry.URL ?? '').trim();
  const localStorage = entry.localStorage && typeof entry.localStorage === 'object' ? entry.localStorage : {};
  const sessionStorage = entry.sessionStorage && typeof entry.sessionStorage === 'object' ? entry.sessionStorage : {};
  if (!origin && !url) return null;
  return { origin, url, localStorage, sessionStorage };
}

function normalizeBrowserStorageEntries(browserStorage) {
  if (!Array.isArray(browserStorage)) return [];
  return browserStorage.map(normalizeBrowserStorageEntry).filter(Boolean);
}

function extractBrowserStorageFromResponse(source) {
  if (!source || typeof source !== 'object') return [];
  const candidates = [
    source.browserStorage,
    source.browser_storage,
    source.data?.browserStorage,
    source.data?.browser_storage,
    source.result?.browserStorage,
    source.result?.browser_storage,
    source.payload?.browserStorage,
    source.payload?.browser_storage,
  ];
  for (const value of candidates) {
    const normalized = normalizeBrowserStorageEntries(value);
    if (normalized.length > 0) return normalized;
  }
  return [];
}

module.exports = {
  extractBrowserStorageFromResponse,
  normalizeBrowserStorageEntries,
};
