'use strict';

const {
  normalizeAiFreeBrowserSettings,
  parseCookieJson,
} = require('../../utils/ai-free-browser-settings');
const {
  buildAppliedBrowserEnvironment,
  buildAppliedBrowserSettings,
  resolveChromiumExtensionPaths,
  resolveChromiumExtraArgs,
  resolveConfiguredBrowserProxy,
} = require('./browser-environment');
const { getClashMiniStatus } = require('../network/clash-mini-control-runtime');
const { callOptional, firstText } = require('../../../shared/safe-values');

function getChromiumInstance(browserRuntimeManager, tabId) {
  const chromium = browserRuntimeManager && browserRuntimeManager.chromium;
  const instances = chromium && chromium.instances;
  return instances && typeof instances.get === 'function' ? instances.get(String(tabId)) : null;
}

function resolveEffectiveBrowserProxy(deps, normalized) {
  const clashStatus = typeof getClashMiniStatus === 'function' ? getClashMiniStatus() : null;
  const globalMagicEnabled = Boolean(clashStatus && clashStatus.running === true && clashStatus.enabled === true);
  const configuredProxy = resolveConfiguredBrowserProxy(normalized);
  const magicProxy = callOptional(deps, 'getBrowserProxyEndpoint');
  const effectiveProxy = globalMagicEnabled ? magicProxy : configuredProxy;
  return { effectiveProxy: effectiveProxy || { enabled: false }, globalMagicEnabled };
}

function applyProfileToRuntime(instance, tab, browserProfile, normalized, proxyState) {
  if (!instance || !instance.profile) return;
  const { effectiveProxy, globalMagicEnabled } = proxyState;
  instance.profile.locale = firstText(browserProfile && browserProfile.locale);
  instance.profile.acceptLanguage = firstText(browserProfile && browserProfile.acceptLanguage);
  instance.profile.timezoneId = firstText(browserProfile && browserProfile.timezoneId);
  instance.profile.userAgent = firstText(browserProfile && browserProfile.userAgent);
  instance.profile.browserEnvironment = buildAppliedBrowserEnvironment(browserProfile);
  instance.profile.browserSettingsSnapshot = buildAppliedBrowserSettings(normalized);
  instance.profile.proxyServer = effectiveProxy.enabled ? firstText(effectiveProxy.server) : '';
  instance.profile.proxyBypassList = effectiveProxy.enabled ? firstText(effectiveProxy.bypassRules) : '';
  instance.profile.extraArgs = resolveChromiumExtraArgs(normalized);
  tab.networkMagicApplied = globalMagicEnabled && effectiveProxy.enabled === true;
}

async function applyConfiguredCookies(deps, tabId, normalized) {
  const configuredCookies = parseCookieJson(normalized);
  const runtime = deps.browserRuntimeManager;
  if (!configuredCookies.length || !runtime || typeof runtime.setCookies !== 'function') return;
  try {
    await runtime.setCookies(tabId, configuredCookies);
  } catch (error) {
    callOptional(deps.logger || console, 'warn', '[ChromiumRuntime] AI-FREE Cookie 更新失败:', firstText(error && error.message, error));
  }
}

async function setTabBrowserSettings(deps, tabId, settings, options = {}) {
    const { browserRuntimeManager, resolveTabBrowserProfile, resolveTabs, updateTabs } = deps;
    const logger = deps.logger || console;
    try {
      const tabs = resolveTabs();
      const tab = tabs.get(firstText(tabId));
      if (!tab) return { ok: false, message: '当前没有可配置的浏览器标签页' };
      const normalized = normalizeAiFreeBrowserSettings(settings);
      const proxyState = resolveEffectiveBrowserProxy(deps, normalized);
      const browserProfile = await resolveTabBrowserProfile({
        browserSettings: normalized,
        logger,
      });
      tab.browserSettings = { ...((tab.browserSettings && typeof tab.browserSettings === 'object') ? tab.browserSettings : {}), ...normalized };
      tab.browserProfile = browserProfile;
      tabs.set(tab.id, tab);
      applyProfileToRuntime(getChromiumInstance(browserRuntimeManager, tab.id), tab, browserProfile, normalized, proxyState);
      await applyConfiguredCookies(deps, tab.id, normalized);
      if (options.restartChromium === true && browserRuntimeManager) {
        const state = await browserRuntimeManager.restart(tab.id);
        tab.runtimeStatus = firstText(state && state.status, tab.runtimeStatus);
        updateTabs(true);
        return { ok: true, applied: true, restarted: true, runtimeType: 'chromium' };
      }
      updateTabs(true);
      return { ok: true, applied: false, restartRequired: true, runtimeType: 'chromium' };
    } catch (error) {
      callOptional(logger, 'warn', '[BrowserSettings] 应用标签参数失败:', firstText(error && error.message, error));
      return { ok: false, message: firstText(error && error.message, error) };
    }
}
  
async function refreshBrowsersAfterExtensionChange(deps, change = {}) {
    const { browserRuntimeManager, extensionManager, resolveTabs, sendToSide, updateTabs } = deps;
    const logger = deps.logger || console;
    const entries = Array.from(resolveTabs().values());
    let chromiumRestarted = 0;
    const failures = [];
  
    for (const tab of entries) {
      try {
        const instance = getChromiumInstance(browserRuntimeManager, tab.id);
        if (!instance || !instance.profile) continue;
        instance.profile.extensionPaths = resolveChromiumExtensionPaths(tab.browserSettings || {}, extensionManager);
        const runtimeState = await browserRuntimeManager.restart(tab.id);
        tab.runtimeStatus = firstText(runtimeState && runtimeState.status, tab.runtimeStatus);
        chromiumRestarted += 1;
      } catch (error) {
        failures.push({ tabId: firstText(tab.id), runtimeType: 'chromium', message: firstText(error && error.message, error) });
        callOptional(logger, 'warn', `[Extensions] Chromium 环境 ${tab.id} 刷新失败:`, firstText(error && error.message, error));
      }
    }
  
    const result = {
      ok: failures.length === 0,
      pluginId: firstText(change && change.plugin && change.plugin.id),
      enabled: Boolean(change && change.enabled === true),
      chromiumRestarted,
      total: chromiumRestarted,
      failures,
    };
    updateTabs(true);
    try { sendToSide('extension-browsers-refreshed', result); } catch (_) {}
    return result;
}

function createBrowserRuntimeSettingsController(deps = {}) {
  return {
    refreshBrowsersAfterExtensionChange: (change) => refreshBrowsersAfterExtensionChange(deps, change),
    setTabBrowserSettings: (tabId, settings, options) => setTabBrowserSettings(deps, tabId, settings, options),
  };
}

module.exports = { createBrowserRuntimeSettingsController };
