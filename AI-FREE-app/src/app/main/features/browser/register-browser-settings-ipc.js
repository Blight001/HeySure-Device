'use strict';

const { net, session: electronSession } = require('electron');
const {
  DEFAULT_AI_FREE_BROWSER_SETTINGS,
  normalizeAiFreeBrowserSettings,
} = require('../../utils/ai-free-browser-settings');
const { readStoreConfigSafe, writeStoreConfigSafe } = require('../../ipc/register/store-utils');
const {
  syncOpenTabsToBrowserHistory,
  writeBrowserHistorySafe,
} = require('./browser-history-service');
const { callOptional, firstText } = require('../../../shared/safe-values');

function text(...values) {
  return firstText(...values).trim();
}

function errorMessage(error, fallback = '') {
  return text(error && error.message, error, fallback);
}

const getBrowserRuntimeInfo = () => ({
  chromiumVersion: text(process.versions && process.versions.chrome),
  electronVersion: text(process.versions && process.versions.electron),
});

function validateCookieSettings(input) {
  const rawCookies = input.cookies;
  if (rawCookies === undefined || Array.isArray(rawCookies)) return;
  let parsed;
  try {
    parsed = JSON.parse(String(rawCookies || '[]'));
  } catch (_) {
    throw new Error('Cookie 必须是有效的 JSON 数组');
  }
  if (!Array.isArray(parsed)) throw new Error('Cookie 顶层必须是数组');
}

function validateBrowserSettingsPayload(input = {}) {
  validateCookieSettings(input);
  const secChUa = input.secChUa && typeof input.secChUa === 'object' ? input.secChUa : {};
  if (secChUa.mode === 'custom' && !Array.isArray(secChUa.brands)) {
    throw new Error('Sec-CH-UA 必须是数组');
  }
  const homepage = input.homepage && typeof input.homepage === 'object' ? input.homepage : {};
  if (homepage.mode === 'custom') {
    const parsed = new URL(String(homepage.url || ''));
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('启动主页仅支持 HTTP/HTTPS');
  }
}

function tabValues(ui) {
  const tabs = ui && typeof ui.getTabs === 'function' ? ui.getTabs() : new Map();
  return tabs && typeof tabs.values === 'function' ? Array.from(tabs.values()) : [];
}

function findHistoryTab(ui, historyId) {
  return tabValues(ui).find((tab) => text(tab && tab.browserHistoryId) === historyId) || null;
}

function resolveSavedBrowserSettings(store, record) {
  if (record) return record.settings;
  const stored = store && store.aiFreeBrowserSettings;
  return stored && typeof stored === 'object' ? stored : DEFAULT_AI_FREE_BROWSER_SETTINGS;
}

function resolveSettingsActiveTab(ui, historyTab) {
  const fallbackTabId = ui && typeof ui.getActiveTabId === 'function' ? ui.getActiveTabId() : null;
  const activeTabId = historyTab ? historyTab.id : fallbackTabId;
  return tabValues(ui).find((tab) => tab.id === activeTabId) || null;
}

async function getBrowserSettings(deps, payload) {
  try {
    const store = readStoreConfigSafe();
    const historyId = text(payload && payload.historyId);
    const history = historyId ? syncOpenTabsToBrowserHistory(deps.ui) : [];
    const record = history.find((item) => item.id === historyId) || null;
    const saved = resolveSavedBrowserSettings(store, record);
    const historyTab = record ? findHistoryTab(deps.ui, historyId) : null;
    const activeTab = resolveSettingsActiveTab(deps.ui, historyTab);
    return {
      ok: true,
      settings: normalizeAiFreeBrowserSettings(saved),
      historyId: record ? record.id : '',
      runtimeInfo: getBrowserRuntimeInfo(),
      activeTab: activeTab ? {
        id: text(activeTab.id),
        title: text(activeTab.fixedTitle, activeTab.runtimeTitle, '当前环境'),
        runtimeType: 'chromium',
      } : null,
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error), settings: normalizeAiFreeBrowserSettings({}) };
  }
}

function runProxyTestRequest(testSession, proxy) {
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: 'GET',
      url: 'https://api.ipify.org?format=json',
      session: testSession,
    });
    const timer = setTimeout(() => {
      request.abort();
      reject(new Error('代理检测超时'));
    }, 12000);
    request.on('login', (_authInfo, callback) => callback(proxy.username || '', proxy.password || ''));
    request.on('response', (response) => {
      let body = '';
      response.on('data', (chunk) => { body += String(chunk); });
      response.on('end', () => {
        clearTimeout(timer);
        resolve({ statusCode: response.statusCode, body });
      });
    });
    request.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}

function proxyTestIp(result) {
  try {
    return text(JSON.parse(result.body).ip);
  } catch (_) {
    return text(result.body);
  }
}

async function testBrowserProxy(payload) {
  const proxy = normalizeAiFreeBrowserSettings({ proxy: payload && payload.proxy }).proxy;
  if (proxy.mode !== 'custom' || !proxy.host || !proxy.port) {
    return { ok: false, error: '请先填写代理主机和端口' };
  }
  const startedAt = Date.now();
  try {
    const testSession = electronSession.fromPartition(`ai-free-proxy-test-${Date.now()}`, { cache: false });
    await testSession.setProxy({ proxyRules: `${proxy.protocol}://${proxy.host}:${proxy.port}` });
    const result = await runProxyTestRequest(testSession, proxy);
    if (Number(result.statusCode) < 200 || Number(result.statusCode) >= 400) {
      throw new Error(`代理返回 HTTP ${result.statusCode}`);
    }
    return { ok: true, ip: proxyTestIp(result), elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, error: errorMessage(error), elapsedMs: Date.now() - startedAt };
  }
}

function normalizeProxyObject(value) {
  const source = /** @type {Record<string, any>} */ (value);
  const proxy = normalizeAiFreeBrowserSettings({ proxy: {
    mode: 'custom',
    protocol: source.protocol || source.type || 'http',
    host: source.host || source.ip || source.hostname,
    port: source.port,
    username: source.username || source.user,
    password: source.password || source.pass,
  } }).proxy;
  if (!proxy.host || !proxy.port) throw new Error('API 返回中没有代理主机或端口');
  return proxy;
}

function normalizeProxyText(value) {
  const match = String(value).match(/(?:(https?|socks[45]):\/\/)?(?:([^:@\s]+):([^@\s]+)@)?([^:\s]+):(\d+)(?::([^:\s]+):([^\s]+))?/i);
  if (!match) throw new Error('无法识别 API 返回的代理格式');
  return normalizeAiFreeBrowserSettings({ proxy: {
    mode: 'custom',
    protocol: match[1] || 'http',
    host: match[4],
    port: match[5],
    username: match[2] || match[6] || '',
    password: match[3] || match[7] || '',
  } }).proxy;
}

function parseProxyApiResponse(raw) {
  try {
    const json = JSON.parse(raw);
    const data = json && json.data;
    const source = data && data.proxy || json.proxy || data || json;
    return source !== null && typeof source === 'object'
      ? normalizeProxyObject(source)
      : normalizeProxyText(source);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return normalizeProxyText(raw);
  }
}

async function extractBrowserProxy(payload) {
  try {
    const parsedUrl = new URL(text(payload && payload.apiUrl));
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('API 链接仅支持 HTTP/HTTPS');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    let response;
    try {
      response = await net.fetch(parsedUrl.href, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`API 返回 HTTP ${response.status}`);
    return { ok: true, proxy: parseProxyApiResponse((await response.text()).trim()) };
  } catch (error) {
    const message = error && error.name === 'AbortError' ? '代理 API 请求超时' : errorMessage(error);
    return { ok: false, error: message };
  }
}

function persistHistorySettings(ui, historyId, settings, failureMessage) {
  const history = syncOpenTabsToBrowserHistory(ui);
  const record = history.find((item) => item.id === historyId);
  if (!record) return { error: '浏览器历史不存在', tabId: null };
  record.settings = settings;
  if (!writeBrowserHistorySafe(history)) return { error: failureMessage, tabId: null };
  const tab = findHistoryTab(ui, historyId);
  return { error: '', tabId: tab ? tab.id : null };
}

function persistDefaultSettings(licenseCache, settings, failureMessage) {
  const currentStore = readStoreConfigSafe();
  const wrote = writeStoreConfigSafe({
    ...(currentStore && typeof currentStore === 'object' ? currentStore : {}),
    aiFreeBrowserSettings: settings,
  });
  if (!wrote) return failureMessage;
  callOptional(licenseCache, 'setRuntimeConfig', { browserSettings: settings });
  return '';
}

function persistBrowserSettingsTarget(deps, historyId, settings, reset) {
  if (historyId) {
    const result = persistHistorySettings(
      deps.ui,
      historyId,
      settings,
      reset ? '独立浏览器默认参数未能写入本地配置' : '独立浏览器参数未能写入本地配置',
    );
    return { error: result.error, targetTabId: result.tabId };
  }
  return {
    error: persistDefaultSettings(
      deps.licenseCache,
      settings,
      reset ? '默认参数未能写入本地配置' : '参数未能写入本地配置',
    ),
    targetTabId: null,
  };
}

async function applySavedBrowserSettings(deps, payload, historyId, targetTabId, settings) {
  if (!payload || payload.applyToActive === false) return null;
  const defaultTabId = deps.ui && typeof deps.ui.getActiveTabId === 'function'
    ? deps.ui.getActiveTabId()
    : null;
  const activeTabId = historyId ? targetTabId : defaultTabId;
  if (!activeTabId || !deps.ui || typeof deps.ui.setTabBrowserSettings !== 'function') return null;
  return deps.ui.setTabBrowserSettings(activeTabId, settings, {
    restartChromium: payload.restartChromium === true,
  });
}

async function writeBrowserSettings(deps, payload, reset) {
  try {
    const rawSettings = reset ? {} : payload && (payload.settings || payload);
    if (!reset) validateBrowserSettingsPayload(rawSettings);
    const settings = normalizeAiFreeBrowserSettings(rawSettings || {});
    const historyId = text(payload && payload.historyId);
    const persisted = persistBrowserSettingsTarget(deps, historyId, settings, reset);
    if (persisted.error) return { ok: false, error: persisted.error };
    const activeResult = await applySavedBrowserSettings(
      deps,
      payload,
      historyId,
      persisted.targetTabId,
      settings,
    );
    callOptional(deps.ui, 'sendToSide', 'browser-history-changed');
    return { ok: true, settings, historyId, activeResult, runtimeInfo: getBrowserRuntimeInfo() };
  } catch (error) {
    if (!reset) console.error('[IPC] 保存 AI-FREE 浏览器参数失败:', error);
    return { ok: false, error: errorMessage(error) };
  }
}

function registerBrowserSettingsIpc({ ipc, ui, licenseCache }) {
  const deps = { ui, licenseCache };
  ipc.handle('get-ai-free-browser-settings', (_event, payload = {}) => getBrowserSettings(deps, payload));
  ipc.handle('test-ai-free-proxy', (_event, payload = {}) => testBrowserProxy(payload));
  ipc.handle('extract-ai-free-proxy', (_event, payload = {}) => extractBrowserProxy(payload));
  ipc.handle('set-ai-free-browser-settings', (_event, payload = {}) => writeBrowserSettings(deps, payload, false));
  ipc.handle('reset-ai-free-browser-settings', (_event, payload = {}) => writeBrowserSettings(deps, payload, true));
}

module.exports = { registerBrowserSettingsIpc, validateBrowserSettingsPayload };
