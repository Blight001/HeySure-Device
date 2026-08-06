const { postJson } = require('./http');
const { sanitizeUserFacingMessage } = require('../utils/messages');
const {
  extractNestedText,
  extractValidationState,
  getValidationFailureMessage,
  isValidationSuccess,
} = require('../utils/license-response');
const { extractBrowserStorageFromResponse } = require('../utils/browser-storage');
const {
  extractCurrentAccountTypeInfo,
  extractServerRecycleDebugInfo,
  extractServerRecycleTimeInfo,
} = require('../features/account/account-response-normalizer');

function createBusinessError(message, code = 'BUSINESS_ERROR') {
  return Object.assign(new Error(message), {
    businessError: true,
    noHttpFallback: true,
    errorCode: code,
  });
}

function extractAccount(source) {
  if (!source || typeof source !== 'object') return '';
  const containers = [source, source.data, source.result, source.payload].filter(Boolean);
  for (const container of containers) {
    for (const field of ['account', 'accountName', 'username', 'user_name']) {
      const value = String(container[field] || '').trim();
      if (value) return value;
    }
  }
  return '';
}

function extractReportedAccount(source, fallbackLabel = '') {
  const account = extractAccount(source);
  if (account) return account;
  const match = String(source?.message || '').match(/已分配账号[：:]\s*([^\s（()]+)/);
  if (match?.[1]) {
    console.log(`[fetchCookieFromServerForDream] 从message中解析到账号${fallbackLabel}: ${match[1]}`);
    return match[1];
  }
  return '未知账号';
}

function normalizeServerCookies(raw, getTargetUrl) {
  if (!raw) return [];
  let cookies;
  if (Array.isArray(raw)) {
    cookies = raw.filter((item) => item && typeof item === 'object');
  } else if (typeof raw === 'object' && Array.isArray(raw.cookies)) {
    cookies = raw.cookies.filter((item) => item && typeof item === 'object');
  } else if (typeof raw === 'object') {
    cookies = Object.entries(raw).map(([name, value]) => ({ name: String(name), value: String(value) }));
  } else {
    cookies = [];
  }
  return cookies.map((cookie) => {
    const normalized = { path: '/', ...cookie };
    if (normalized.url) return normalized;
    const host = normalized.domain ? String(normalized.domain).replace(/^\./, '') : '';
    normalized.url = host ? `https://${host}/` : getTargetUrl();
    return normalized;
  });
}

function logSuccessReport({ account, cookies, currentAccountTypeInfo, fallback, platform, getPlatform }) {
  try {
    const resolvedPlatform = platform || getPlatform();
    const typeLabel = currentAccountTypeInfo.currentAccountTypeLabel;
    const typeSuffix = typeLabel ? ` | 类型:${typeLabel}` : '';
    const fallbackSuffix = fallback ? '(HTTP降级)' : '';
    console.log(`[fetchCookieFromServerForDream] Cookie获取成功${fallbackSuffix} | 平台:${resolvedPlatform} | 账号:${account}${typeSuffix} | Cookie数量:${cookies.length}`);
  } catch (error) {
    console.warn('[fetchCookieFromServerForDream] 生成报告消息失败:', error.message);
    try {
      const resolvedPlatform = fallback ? getPlatform() : '即梦';
      const fallbackSuffix = fallback ? '(HTTP降级)' : '';
      console.log(`[fetchCookieFromServerForDream] 平台=${resolvedPlatform} 已获取账号Cookie${fallbackSuffix}`);
    } catch (fallbackError) {
      console.warn('[fetchCookieFromServerForDream] 降级报告也失败:', fallbackError.message);
    }
  }
}

function buildResult({ source, cookies, account, platform, requestedTargetUrl }) {
  const currentAccountTypeInfo = extractCurrentAccountTypeInfo(source);
  const rawSubUrls = source.subUrls || source.sub_urls;
  const subUrls = Array.isArray(rawSubUrls)
    ? rawSubUrls.map((url) => String(url || '').trim()).filter(Boolean)
    : [];
  return {
    cookies,
    browserStorage: extractBrowserStorageFromResponse(source),
    account,
    platform,
    currentPlatform: String(source.currentPlatform || source.current_platform || source.platform || platform).trim(),
    currentUrl: String(source.targetUrl || source.target_url || source.currentUrl || requestedTargetUrl).trim(),
    subUrls,
    ...extractServerRecycleTimeInfo(source),
    ...currentAccountTypeInfo,
    current_account_type: currentAccountTypeInfo.currentAccountType,
    current_account_type_label: currentAccountTypeInfo.currentAccountTypeLabel,
    currentAccountType: currentAccountTypeInfo.currentAccountType,
    currentAccountTypeLabel: currentAccountTypeInfo.currentAccountTypeLabel,
  };
}

function assertSuccessfulResponse(source, defaultMessage = '账号分配失败') {
  const validationFailed = !isValidationSuccess(source) && (
    source.ok === false
    || source.success === false
    || source.valid === false
    || source.is_valid === false
    || extractValidationState(source)
  );
  if (source.ok && !validationFailed) return;
  const message = getValidationFailureMessage(source, source.message || source.msg || defaultMessage);
  throw createBusinessError(sanitizeUserFacingMessage(message, defaultMessage), 'ACCOUNT_FETCH_FAILED');
}

function logPrimaryResponse(response) {
  const typeInfo = extractCurrentAccountTypeInfo(response);
  const recycleInfo = extractServerRecycleDebugInfo(response);
  const responseLog = {
    ok: response.ok,
    hasCookies: !!response.cookies,
    hasData: !!response.data,
    hasCookie: !!response.cookie,
    platform: response.platform,
    currentAccountType: typeInfo.currentAccountType || undefined,
    currentAccountTypeLabel: typeInfo.currentAccountTypeLabel || undefined,
    ...recycleInfo,
    message: extractNestedText(response).substring(0, 100) || undefined,
    cookiesCount: response.cookies ? response.cookies.length : 0,
  };
  console.log('[fetchCookieFromServerForDream] 响应内容:', JSON.stringify(responseLog, null, 2));
}

async function fetchFromClient(deps, request) {
  const { httpClient, getTargetUrl, getPlatform, saveLicenseUsageSnapshot } = deps;
  const { key, deviceId, requestedPlatform, requestedTargetUrl } = request;
  console.log('[fetchCookieFromServerForDream] 使用HTTP获取Cookie');
  console.log(`[fetchCookieFromServerForDream] 发送账号请求: platform=${requestedPlatform}, deviceId=${deviceId.substring(0, 8)}***`);
  const response = await httpClient.fetchCookie(key, requestedPlatform, deviceId);
  console.log(`[fetchCookieFromServerForDream] HTTP响应接收完成，响应类型: ${typeof response}`);
  logPrimaryResponse(response);
  try {
    assertSuccessfulResponse(response);
  } catch (error) {
    console.log('[fetchCookieFromServerForDream] 请求失败，即将抛出错误:', error.message);
    throw error;
  }
  const rawCookies = response.cookies || response.data || response.cookie;
  console.log(`[fetchCookieFromServerForDream] 提取到原始cookie数据，类型:${typeof rawCookies}, 长度:${Array.isArray(rawCookies) ? rawCookies.length : 'N/A'}`);
  const cookies = normalizeServerCookies(rawCookies, getTargetUrl);
  console.log(`[fetchCookieFromServerForDream] 标准化后cookie数量: ${cookies.length}`);
  if (!cookies.length) {
    console.error('[fetchCookieFromServerForDream] 标准化后没有可用cookie');
    throw createBusinessError('服务器未返回可用账号信息', 'ACCOUNT_EMPTY');
  }
  const account = extractReportedAccount(response);
  const currentAccountTypeInfo = extractCurrentAccountTypeInfo(response);
  logSuccessReport({ account, cookies, currentAccountTypeInfo, fallback: false, platform: response.platform || '即梦', getPlatform });
  saveLicenseUsageSnapshot({ key, deviceId, source: response });
  return buildResult({ source: response, cookies, account, platform: requestedPlatform, requestedTargetUrl });
}

function assertSuccessfulFallback(response) {
  const body = response.body;
  const rejected = [body?.success, body?.valid, body?.is_valid].some((value) => value === false);
  if (response.ok && !rejected) return;
  const message = getValidationFailureMessage(body || response, body?.message || body?.msg || '账号分配失败');
  throw createBusinessError(sanitizeUserFacingMessage(message, '账号分配失败'), 'ACCOUNT_FETCH_FAILED');
}

async function fetchFromFallback(deps, request) {
  const { getTargetUrl, getPlatform, resolveServerBase, saveLicenseUsageSnapshot } = deps;
  const { key, deviceId, requestedPlatform, requestedTargetUrl } = request;
  const serverBase = resolveServerBase();
  if (!serverBase) throw new Error('HTTP服务器地址未配置');
  console.log('[fetchCookieFromServerForDream] HTTP降级获取Cookie');
  const response = await postJson(`${serverBase}/api/fetch_cookie`, {
    session_token: key,
    device_id: deviceId,
    platform: requestedPlatform,
  });
  console.log('[fetchCookieFromServerForDream] 服务器响应:', { status: response.status, ok: response.ok });
  assertSuccessfulFallback(response);
  const body = response.body;
  if (!body) throw new Error('服务器响应为空');
  const cookies = normalizeServerCookies(body.cookies || body.data || body.cookie, getTargetUrl);
  if (!cookies.length) throw createBusinessError('服务器未返回可用账号信息', 'ACCOUNT_EMPTY');
  const account = extractReportedAccount(body, '(HTTP降级)');
  const currentAccountTypeInfo = extractCurrentAccountTypeInfo(body);
  logSuccessReport({ account, cookies, currentAccountTypeInfo, fallback: true, platform: body.platform, getPlatform });
  saveLicenseUsageSnapshot({ key, deviceId, source: body });
  return buildResult({ source: body, cookies, account, platform: requestedPlatform || '', requestedTargetUrl });
}

function createAuthCookieFetcher(deps) {
  return async function fetchCookieFromServerForDream(key, deviceId, options = {}) {
    const request = {
      key,
      deviceId,
      requestedPlatform: String(options.platform || options.platformName || '').trim() || deps.getPlatform(),
      requestedTargetUrl: String(options.targetUrl || '').trim() || deps.getTargetUrl(),
    };
    if (deps.httpClient) {
      try {
        return await fetchFromClient(deps, request);
      } catch (error) {
        if (error?.noHttpFallback || error?.businessError) throw error;
        console.warn('[fetchCookieFromServerForDream] TCP失败，尝试HTTP降级:', error?.message || error);
      }
    }
    return fetchFromFallback(deps, request);
  };
}

module.exports = { createAuthCookieFetcher };
