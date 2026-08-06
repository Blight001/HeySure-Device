'use strict';

const { app } = require('electron');

function resolveCookieUrl(cookie, getTargetUrlFromStore) {
  if (cookie.url) return cookie.url;
  if (cookie.domain) return `https://${String(cookie.domain).replace(/^\./, '')}/`;
  return getTargetUrlFromStore();
}

function normalizeSessionCookie(source, getTargetUrlFromStore) {
  const cookie = {
    url: resolveCookieUrl(source, getTargetUrlFromStore),
    name: String(source.name),
    value: String(source.value),
    path: source.path || '/',
    secure: Boolean(source.secure),
    httpOnly: Boolean(source.httpOnly || source.httponly),
  };
  if (source.expirationDate) cookie.expirationDate = Number(source.expirationDate);
  if (source.domain) cookie.domain = String(source.domain);
  const sameSite = String(source.sameSite || '').toLowerCase();
  if (['no_restriction', 'lax', 'strict'].includes(sameSite)) cookie.sameSite = sameSite;
  return cookie;
}

async function setCookiesToSession(deps, electronSession, cookies) {
  for (const source of cookies) {
    try {
      if (!source.name) {
        deps.log('Cookie', '单个 Cookie 注入失败：缺少 name 属性。原始数据:', source);
        continue;
      }
      const cookie = normalizeSessionCookie(source, deps.getTargetUrlFromStore);
      await electronSession.cookies.set(cookie);
      deps.log('Cookie', `成功注入 Cookie: ${cookie.name}`);
    } catch (error) {
      deps.log('Cookie', `单个 Cookie 注入失败: ${error?.message || error}`, '原始数据:', source);
    }
  }
}

async function hasSessionCookies(electronSession) {
  try {
    if (typeof electronSession?.cookies?.get !== 'function') return false;
    const cookies = await electronSession.cookies.get({});
    return Array.isArray(cookies) && cookies.length > 0;
  } catch (_) {
    return false;
  }
}

function getBrowserStorageOrigin(urlValue) {
  try { return new URL(String(urlValue || '').trim()).origin; } catch (_) { return ''; }
}

function buildBrowserStorageScript(storageEntry) {
  return `(() => { try {
    const localData=${JSON.stringify(storageEntry.localStorage || {})};
    const sessionData=${JSON.stringify(storageEntry.sessionStorage || {})};
    try{localStorage.clear();}catch(_){} try{sessionStorage.clear();}catch(_){}
    for(const [key,value] of Object.entries(localData)){try{localStorage.setItem(key,String(value));}catch(_){}}
    for(const [key,value] of Object.entries(sessionData)){try{sessionStorage.setItem(key,String(value));}catch(_){}}
  } catch(e){} })();`;
}

function mergeStorageForOrigin(entries, origin) {
  const merged = { localStorage: {}, sessionStorage: {} };
  let matched = false;
  for (const entry of entries) {
    const entryOrigin = getBrowserStorageOrigin(entry.origin || entry.url || '');
    if (!entryOrigin || entryOrigin !== origin) continue;
    matched = true;
    Object.assign(merged.localStorage, entry.localStorage || {});
    Object.assign(merged.sessionStorage, entry.sessionStorage || {});
  }
  return matched ? merged : null;
}

function scheduleStorageReload(webContents, state) {
  if (state.reloadedAfterInject) return;
  state.reloadedAfterInject = true;
  setTimeout(() => {
    try {
      if (webContents.isDestroyed()) return;
      const currentUrl = String(webContents.getURL() || '').trim();
      if (currentUrl && currentUrl !== 'about:blank') webContents.reloadIgnoringCache();
    } catch (_) {}
  }, 0);
}

async function injectBrowserStorage(webContents, state) {
  try {
    if (webContents.isDestroyed()) return;
    const origin = getBrowserStorageOrigin(webContents.getURL());
    if (!origin) return;
    const merged = mergeStorageForOrigin(state.entries, origin);
    if (!merged) return;
    await webContents.executeJavaScript(buildBrowserStorageScript(merged), true).catch(() => {});
    scheduleStorageReload(webContents, state);
  } catch (_) {}
}

function applyBrowserStorageToPage(deps, webContents, browserStorage) {
  try {
    if (typeof webContents?.executeJavaScript !== 'function') return false;
    const entries = deps.normalizeBrowserStorageEntries(browserStorage);
    if (!entries.length) return false;
    const state = deps.browserStorageInjectionState.get(webContents) || {};
    state.entries = entries;
    state.bound = true;
    state.reloadedAfterInject = state.reloadedAfterInject === true;
    deps.browserStorageInjectionState.set(webContents, state);
    const inject = () => injectBrowserStorage(webContents, state);
    if (!state.listenersAttached) {
      state.listenersAttached = true;
      webContents.on('dom-ready', inject);
      webContents.on('did-finish-load', inject);
    }
    void inject();
    return true;
  } catch (error) {
    deps.log('BrowserStorage', `浏览器存储注入失败: ${error?.message || error}`);
    return false;
  }
}

function buildLocaleScript(locale) {
  return `try { if(!localStorage.getItem('i18nextLng')) localStorage.setItem('i18nextLng','${locale}');
    const doc=document.documentElement; if(!doc.getAttribute('lang')) doc.setAttribute('lang','${locale}'); } catch(e) {}`;
}

function bindLocaleInjection(deps, webContents, electronSession) {
  if (!webContents || webContents.isDestroyed() || webContents.session !== electronSession) return;
  webContents.on('dom-ready', async () => {
    try {
      if (!deps.matchesLocaleTargets(webContents.getURL())) return;
      await webContents.executeJavaScript(buildLocaleScript(deps.ZH_HANT_COOKIE_VALUE), true).catch(() => {});
    } catch (error) {
      deps.log('AutoCookie', `自动Cookie注入过程出错: ${error.message}`);
    }
  });
}

function patchLocaleSession(deps, electronSession) {
  deps.patchedSessions.add(electronSession);
  deps.registerRequestHeaderTransformer(electronSession, 'zh-hant-accept-language', (headers, details) => (
    deps.matchesLocaleTargets(details.url)
      ? { ...headers, 'Accept-Language': deps.ZH_HANT_ACCEPT_LANGUAGE }
      : headers
  ));
  void deps.setLocaleCookies(electronSession, deps.log);
  electronSession.webRequest.onBeforeRequest(async (details, callback) => {
    if (deps.matchesLocaleTargets(details.url)) {
      try { await deps.setLocaleCookies(electronSession, deps.log); } catch (_) {}
    }
    callback({});
  });
  app.on('web-contents-created', (_event, contents) => bindLocaleInjection(deps, contents, electronSession));
  deps.log('Locale', '繁体中文偏好注入 + 自动Cookie获取 已启用');
}

function applyZhHantRequestPrefs(deps, electronSession, currentWebContents) {
  try {
    if (!electronSession) return;
    if (!deps.patchedSessions.has(electronSession)) patchLocaleSession(deps, electronSession);
    bindLocaleInjection(deps, currentWebContents, electronSession);
  } catch (error) {
    deps.log('Locale', `启用繁体化偏好失败: ${error?.message || error}`);
  }
}

function createBrowserSessionAuthTools(deps = {}) {
  return {
    applyBrowserStorageToPage: (webContents, storage) => applyBrowserStorageToPage(deps, webContents, storage),
    applyZhHantRequestPrefs: (session, contents) => applyZhHantRequestPrefs(deps, session, contents),
    hasSessionCookies,
    setCookiesToSession: (session, cookies) => setCookiesToSession(deps, session, cookies),
  };
}

module.exports = { createBrowserSessionAuthTools };
