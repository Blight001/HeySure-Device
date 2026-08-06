'use strict';

const {
  getClashMiniStatus,
  getClashMiniProxyEndpoint,
  getClashMiniRuntimeRoot,
} = require('../network/clash-mini-control-runtime');
const { appContext } = require('../../runtime/app-context');
const {
  resolveConfiguredBrowserProxy,
} = require('./browser-environment');
const { callOptional, firstText } = require('../../../shared/safe-values');

function getBrowserProxyEndpoint() {
  const clashMiniStatus = typeof getClashMiniStatus === 'function' ? getClashMiniStatus() : null;
  const coreDir = firstText(
    clashMiniStatus && clashMiniStatus.coreDir,
    typeof getClashMiniRuntimeRoot === 'function' ? getClashMiniRuntimeRoot() : '',
  );
  if (!coreDir) return null;
  const endpoint = typeof getClashMiniProxyEndpoint === 'function' ? getClashMiniProxyEndpoint(coreDir) : null;
  if (!endpoint || !Number.isFinite(Number(endpoint.port))) return null;
  const host = firstText(endpoint.host, '127.0.0.1').trim();
  return {
    enabled: true,
    server: `http://${host || '127.0.0.1'}:${Number(endpoint.port)}`,
    bypassRules: '<local>;127.0.0.1;localhost;::1',
  };
}

function getChromiumInstance(runtimeManager, tabId) {
  const chromium = runtimeManager && runtimeManager.chromium;
  const instances = chromium && chromium.instances;
  return instances && typeof instances.get === 'function' ? instances.get(String(tabId)) : null;
}

function proxySettingsChanged(profile, server, bypassList) {
  return firstText(profile.proxyServer) !== server || firstText(profile.proxyBypassList) !== bypassList;
}

function resolveTabProxy(tab, enabled, browserProxy) {
  if (enabled) return browserProxy || { enabled: false };
  return resolveConfiguredBrowserProxy(tab.browserSettings || {}) || { enabled: false };
}

async function applyProxyToTab(deps, tab, context) {
  const { enabled, browserProxy, failures } = context;
  try {
    const tabProxy = resolveTabProxy(tab, enabled, browserProxy);
    const instance = getChromiumInstance(deps.browserRuntimeManager, tab.id);
    if (!instance || !instance.profile) {
      tab.networkMagicApplied = false;
      return false;
    }
    const nextProxyServer = tabProxy.enabled ? firstText(tabProxy.server) : '';
    const nextProxyBypassList = tabProxy.enabled ? firstText(tabProxy.bypassRules) : '';
    const proxyChanged = proxySettingsChanged(instance.profile, nextProxyServer, nextProxyBypassList);
    if (!proxyChanged) {
      tab.networkMagicApplied = enabled && Boolean(nextProxyServer);
      return false;
    }
    instance.profile.proxyServer = nextProxyServer;
    instance.profile.proxyBypassList = nextProxyBypassList;
    if (appContext.isShuttingDown()) return false;
    const runtimeState = await deps.browserRuntimeManager.restart(tab.id);
    tab.runtimeStatus = firstText(runtimeState && runtimeState.status, tab.runtimeStatus);
    tab.networkMagicApplied = enabled && Boolean(nextProxyServer);
    return true;
  } catch (error) {
    tab.networkMagicApplied = false;
    const failure = { tabId: firstText(tab.id), message: firstText(error && error.message, error) };
    failures.push(failure);
    callOptional(deps.logger || console, 'warn', `[ChromiumRuntime] 网络魔法代理切换后重启失败 ${failure.tabId}:`, failure.message);
    return false;
  }
}

async function applyClashMiniBrowserProxy(deps, enabled = true, _options = {}) {
  const entries = Array.from(deps.resolveTabs().values());
  const failures = [];
  if (appContext.isShuttingDown()) {
    return { ok: true, enabled: false, updated: 0, total: entries.length, failures, skipped: true };
  }
  const context = {
    enabled: enabled === true,
    browserProxy: getBrowserProxyEndpoint(),
    failures,
  };
  const results = await Promise.all(entries.map((tab) => applyProxyToTab(deps, tab, context)));
  deps.updateTabs(true);
  return {
    ok: failures.length === 0,
    enabled: Boolean(enabled),
    updated: results.filter(Boolean).length,
    total: entries.length,
    failures,
  };
}

function createBrowserNetworkController(deps = {}) {
  return {
    applyClashMiniBrowserProxy: (enabled, options) => applyClashMiniBrowserProxy(deps, enabled, options),
    getBrowserProxyEndpoint,
  };
}

module.exports = { createBrowserNetworkController };
