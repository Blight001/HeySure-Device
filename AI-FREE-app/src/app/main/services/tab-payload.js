const { resolveTabTitle } = require('./tab-common');

function text(value) {
  return String(value || '').trim();
}

/** @param {any} value @param {any} [defaultValue] */
function fallback(value, defaultValue = '') {
  return value || defaultValue;
}

function resolveAppliedProfile(tab, browserRuntimeManager) {
  const instance = browserRuntimeManager?.chromium?.instances?.get?.(String(tab.id));
  return instance?.appliedProfile && typeof instance.appliedProfile === 'object'
    ? instance.appliedProfile
    : null;
}

function resolveActualProfile(tab, applied) {
  const environment = applied?.browserEnvironment;
  const base = environment && typeof environment === 'object' ? environment : tab.browserProfile;
  if (!base) return null;
  return {
    ...base,
    locale: text(applied?.locale || base.locale),
    timezoneId: text(applied?.timezoneId || base.timezoneId),
    acceptLanguage: text(applied?.acceptLanguage || base.acceptLanguage),
    userAgent: text(applied?.userAgent || base.userAgent),
  };
}

function serializeUaBrands(profile) {
  if (!Array.isArray(profile.uaBrands)) return [];
  return profile.uaBrands
    .map((item) => ({ brand: text(item?.brand), version: text(item?.version) }))
    .filter((item) => item.brand);
}

function serializeBrowserProfile(profile) {
  if (!profile) return null;
  const fields = [
    'browserBrand', 'browserType', 'browserVersion', 'majorVersion', 'region', 'regionLabel',
    'sourceIp', 'sourceCountryCode', 'sourceCountry', 'sourceRegion', 'sourceCity', 'locale',
    'timezoneId', 'acceptLanguage', 'userAgent',
  ];
  const result = Object.fromEntries(fields.map((field) => [field, text(profile[field])]));
  result.uaBrands = serializeUaBrands(profile);
  return result;
}

function serializeRuntimeEnvironment(applied, runtimeState) {
  if (!applied) return null;
  return {
    windowWidth: Math.max(0, Number(runtimeState?.bounds?.width) || 0),
    windowHeight: Math.max(0, Number(runtimeState?.bounds?.height) || 0),
    hardwareAcceleration: applied.hardwareAcceleration !== false,
    extensionCount: Math.max(0, Number(applied.extensionCount) || 0),
  };
}

function serializeTab(tab, deps) {
  const applied = resolveAppliedProfile(tab, deps.browserRuntimeManager);
  const runtimeState = deps.browserRuntimeManager?.getState?.(String(tab.id)) || null;
  const actualProxyServer = text(applied?.proxyServer);
  const browserSettings = applied?.browserSettings;
  return {
    id: tab.id,
    title: resolveTabTitle(tab),
    isActive: tab.id === deps.resolveActiveTabId(),
    accountId: text(tab.accountId),
    browserHistoryId: text(tab.browserHistoryId),
    networkMagicEnabled: tab.networkMagicApplied === true && !!actualProxyServer,
    browserSettings: browserSettings && typeof browserSettings === 'object' ? browserSettings : null,
    runtimeEnvironment: serializeRuntimeEnvironment(applied, runtimeState),
    runtimeType: text(tab.runtimeType || 'chromium'),
    runtimeStatus: text(tab.runtimeStatus || 'starting'),
    browserProfile: serializeBrowserProfile(resolveActualProfile(tab, applied)),
  };
}

function buildTabsPayload(deps) {
  return Array.from(deps.resolveTabs().values()).map((tab) => serializeTab(tab, deps));
}

function tabSignatureFields(item) {
  const runtime = item.runtimeEnvironment || {};
  const profile = item.browserProfile || {};
  return [
    item.id, item.title, Number(item.isActive), fallback(item.accountId), fallback(item.browserHistoryId),
    Number(item.networkMagicEnabled), JSON.stringify(item.browserSettings || {}),
    fallback(runtime.windowWidth, 0), fallback(runtime.windowHeight, 0),
    Number(runtime.hardwareAcceleration !== false), fallback(runtime.extensionCount, 0),
    fallback(item.runtimeType), fallback(item.runtimeStatus), fallback(profile.browserBrand),
    fallback(profile.region), fallback(profile.sourceIp), fallback(profile.sourceCountry),
    fallback(profile.sourceRegion), fallback(profile.sourceCity), fallback(profile.locale),
    fallback(profile.timezoneId),
  ];
}

function getTabsSignature(tabData) {
  try {
    return JSON.stringify(tabData.map(tabSignatureFields));
  } catch (_) {
    return '';
  }
}

module.exports = { buildTabsPayload, getTabsSignature };
