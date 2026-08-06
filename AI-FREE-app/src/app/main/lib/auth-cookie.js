// 认证与 Cookie 相关封装
// 通过工厂函数传入依赖（serverBase、sendToSide、log），避免硬编码与循环依赖

const { app } = require('electron');
const { URL } = require('url');
const { getStorePath, getServerBase } = require('../config');
const { registerRequestHeaderTransformer } = require('../utils/session-request-headers');
const { normalizeBrowserStorageEntries } = require('../utils/browser-storage');
const {
  readStoreConfigFile,
  writeStoreConfigFile,
} = require('../utils/json-store');
const { createLicenseUsageStore } = require('../features/account/license-usage-store');
const { createBrowserSessionAuthTools } = require('../features/browser/browser-session-auth-tools');
const { createAuthCookieFetcher } = require('./auth-cookie-fetcher');

let httpClient = null;
let runtimeLicenseCache = null;

// 获取/读取/解析：readStoreConfig的具体业务逻辑。
function readStoreConfig(logPrefix = 'Store') {
  return readStoreConfigFile(getStorePath, {
    logger: console,
    logPrefix,
    readErrorMessage: '读取store/content失败:',
  });
}

/**
 * 从store/content获取平台信息
 * @returns {string} 平台名称，默认为'即梦'
 */
function getPlatformFromStore() {
  try {
    const runtimeConfig = runtimeLicenseCache && typeof runtimeLicenseCache.getRuntimeConfig === 'function'
      ? runtimeLicenseCache.getRuntimeConfig()
      : null;
    const runtimeAllowedPlatforms = Array.isArray(runtimeConfig?.allowedPlatforms) ? runtimeConfig.allowedPlatforms : [];
    if (runtimeAllowedPlatforms.length > 0) {
      return runtimeAllowedPlatforms[0];
    }
    if (runtimeConfig?.platformName) {
      return runtimeConfig.platformName;
    }
  } catch (error) {
    console.warn('[Platform] 读取运行时平台信息失败:', error.message);
  }
  return '即梦'; // 默认值
}

/**
 * 从store/content获取目标URL
 * @returns {string} 目标URL，默认为'https://dreamina.capcut.com/'
 */
function getTargetUrlFromStore() {
  try {
    const runtimeConfig = runtimeLicenseCache && typeof runtimeLicenseCache.getRuntimeConfig === 'function'
      ? runtimeLicenseCache.getRuntimeConfig()
      : null;
    if (runtimeConfig?.targetUrl) {
      return runtimeConfig.targetUrl;
    }
  } catch (error) {
    console.warn('[TargetURL] 读取运行时目标URL失败:', error.message);
  }
  return 'https://dreamina.capcut.com/'; // 默认值
}

// ---- 繁体中文偏好注入（常量与工具，模块级共享，确保同一 session 只装配一次）
const ZH_HANT_ACCEPT_LANGUAGE = 'zh-Hant,zh-TW;q=0.95,zh;q=0.8,en;q=0.7';
const ZH_HANT_COOKIE_VALUE = 'zh-Hant-TW';
const LOCALE_TARGET_HOSTS = ['capcut.com', 'dreamina.capcut.com'];
const patchedSessions = new WeakSet();
const browserStorageInjectionState = new WeakMap();

// 比较/匹配：matchesLocaleTargets的具体业务逻辑。
function matchesLocaleTargets(url) {
  try {
    const u = new URL(url);
    return LOCALE_TARGET_HOSTS.some((host) => u.hostname === host || u.hostname.endsWith('.' + host));
  } catch (_) {
    return false;
  }
}

// 设置/更新/持久化：setLocaleCookies的具体业务逻辑。
async function setLocaleCookies(sess, log = (_scope, _message) => {}) {
  const cookies = [
    // 作用于 capcut.com 及其子域
    {
      url: 'https://capcut.com/',
      domain: '.capcut.com',
      name: 'NEXT_LOCALE',
      value: ZH_HANT_COOKIE_VALUE,
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
    },
    {
      url: 'https://capcut.com/',
      domain: '.capcut.com',
      name: 'capcut_locale',
      value: ZH_HANT_COOKIE_VALUE,
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
    },
    // 作用于 dreamina.capcut.com（即梦）
    {
      url: 'https://dreamina.capcut.com/',
      domain: '.dreamina.capcut.com',
      name: 'NEXT_LOCALE',
      value: ZH_HANT_COOKIE_VALUE,
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
    },
    {
      url: 'https://dreamina.capcut.com/',
      domain: '.dreamina.capcut.com',
      name: 'capcut_locale',
      value: ZH_HANT_COOKIE_VALUE,
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
    },
  ];

  for (const c of cookies) {
    try {
      await sess.cookies.set(c);
    } catch (e) {
      log('Locale', `语言 Cookie 注入失败: ${e?.message || e}`);
    }
  }
}

// 创建/初始化：createAuthCookie的具体业务逻辑。
/** @param {{serverBase?: any, httpClient?: any, sendToSide?: Function, log?: Function, licenseCache?: any}} [options] */
function createAuthCookie(options = {}) {
  const {
    serverBase: serverBaseInput,
    httpClient: injectedHttpClient,
    sendToSide = () => {},
    log = () => {},
    licenseCache,
  } = options;
  httpClient = injectedHttpClient;
  runtimeLicenseCache = licenseCache || null;

// 获取/读取/解析：resolveServerBase的具体业务逻辑。
  function resolveServerBase() {
    try {
      const runtimeConfig = runtimeLicenseCache && typeof runtimeLicenseCache.getRuntimeConfig === 'function'
        ? runtimeLicenseCache.getRuntimeConfig()
        : null;
      const runtimeBase = String(runtimeConfig?.serverBase || '').trim();
      if (runtimeBase) return runtimeBase.replace(/\/+$/, '');
    } catch (_) {}
    try {
      const clientRuntimeBase = String(injectedHttpClient?.runtimeServerBase || '').trim();
      if (clientRuntimeBase) return clientRuntimeBase.replace(/\/+$/, '');
    } catch (_) {}
    return String(serverBaseInput || getServerBase() || '').replace(/\/+$/, '');
  }

// 获取/读取/解析：readStoreConfigSafe的具体业务逻辑。
  function readStoreConfigSafe() {
    return readStoreConfig('LicenseUsage');
  }

// 设置/更新/持久化：writeStoreConfigSafe的具体业务逻辑。
  function writeStoreConfigSafe(storeConfig) {
    return writeStoreConfigFile(getStorePath, storeConfig, {
      logger: console,
      logPrefix: 'LicenseUsage',
      writeErrorMessage: '写入store/content失败:',
    });
  }

  const {
    getStoredLicenseUsage,
    saveLicenseUsageSnapshot,
  } = createLicenseUsageStore({
    getRuntimeLicenseCache: () => runtimeLicenseCache,
    readStoreConfigSafe,
    sendToSide,
    writeStoreConfigSafe,
  });

  const fetchCookieFromServerForDream = createAuthCookieFetcher({
    getPlatform: getPlatformFromStore,
    getTargetUrl: getTargetUrlFromStore,
    httpClient: injectedHttpClient,
    resolveServerBase,
    saveLicenseUsageSnapshot,
  });

  const {
    applyBrowserStorageToPage,
    applyZhHantRequestPrefs,
    hasSessionCookies,
    setCookiesToSession,
  } = createBrowserSessionAuthTools({
    browserStorageInjectionState,
    getTargetUrlFromStore,
    log,
    matchesLocaleTargets,
    normalizeBrowserStorageEntries,
    patchedSessions,
    registerRequestHeaderTransformer,
    setLocaleCookies,
    ZH_HANT_ACCEPT_LANGUAGE,
    ZH_HANT_COOKIE_VALUE,
  });


  return {
    fetchCookieFromServerForDream,
    setCookiesToSession,
    hasSessionCookies,
    applyBrowserStorageToPage,
    applyZhHantRequestPrefs,
    saveLicenseUsageSnapshot,
    getStoredLicenseUsage,
  };
}

module.exports = {
  createAuthCookie,
};
