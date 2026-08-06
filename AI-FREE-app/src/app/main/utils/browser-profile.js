const { app } = require('electron');
const {
  REGION_PRESETS,
  getBrowserRegionPreset,
  inferBrowserRegionKeyFromLocale,
} = require('./browser-region');
const { firstNonNull, firstText } = require('../../shared/safe-values');

const TAB_PLATFORM = 'Win32';

function text(...values) {
  return firstText(...values).trim();
}

function getChromiumVersion() {
  return String(process.versions?.chrome || '122.0.0.0').trim() || '122.0.0.0';
}

function getChromiumMajorVersion() {
  return getChromiumVersion().split('.')[0] || '122';
}

function getDefaultLocale() {
  try {
    const locale = String(app?.getLocale?.() || '').trim().replace('_', '-');
    if (locale) return locale;
  } catch (_) {}
  try {
    return String(Intl.DateTimeFormat().resolvedOptions().locale || 'en-US').replace('_', '-');
  } catch (_) {
    return 'en-US';
  }
}

function normalizeLocale(locale) {
  return String(locale || '').trim().replace('_', '-') || getDefaultLocale();
}

function normalizeRegionKey(region) {
  return String(region || '').trim().toLowerCase().replace(/\s+/g, '');
}

function getAcceptLanguage(locale) {
  const normalized = normalizeLocale(locale);
  const primary = normalized.split('-')[0] || 'en';
  return `${normalized},${primary};q=0.9,en-US;q=0.8,en;q=0.7`;
}

function getTimezoneOffsetMinutes(timezoneId) {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezoneId,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const localAsUtc = Date.UTC(
      Number(values.year), Number(values.month) - 1, Number(values.day),
      Number(values.hour), Number(values.minute), Number(values.second),
    );
    return -Math.round((localAsUtc - now.getTime()) / 60000);
  } catch (_) {
    return new Date().getTimezoneOffset();
  }
}

function positiveNumber(value, fallback, minimum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

function resolveBrowserMajorVersion(settings) {
  const kernelVersion = text(settings.kernelVersion);
  const usableKernel = kernelVersion
    && kernelVersion.toLowerCase() !== 'auto'
    && /^\d/.test(kernelVersion);
  const kernelMajor = usableKernel ? kernelVersion.split('.')[0] : '';
  return text(kernelMajor, settings.browserVersion, getChromiumMajorVersion()).split('.')[0]
    || getChromiumMajorVersion();
}

function resolveBrowserUserAgent(settings, os, major) {
  const osTokens = { win7: 'Windows NT 6.1', win8: 'Windows NT 6.2' };
  const osToken = osTokens[os] || 'Windows NT 10.0';
  const fallback = `Mozilla/5.0 (${osToken}; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  const ua = settings.ua && typeof settings.ua === 'object' ? settings.ua : {};
  return ua.mode === 'custom'
    ? text(ua.value, fallback)
    : text(settings.user_agent, settings.userAgent, fallback);
}

function resolveBrowserUaBrands(settings, major) {
  const defaults = [
    { brand: 'Chromium', version: major },
    { brand: 'Google Chrome', version: major },
    { brand: 'Not_A Brand', version: '24' },
  ];
  const secChUa = settings.secChUa && typeof settings.secChUa === 'object' ? settings.secChUa : {};
  return secChUa.mode === 'custom' && Array.isArray(secChUa.brands) && secChUa.brands.length
    ? secChUa.brands
    : defaults;
}

function resolveBrowserIdentity(settings, preset) {
  const locale = normalizeLocale(text(
    settings.locale,
    settings.browser_locale,
    settings.browserLocale,
    getDefaultLocale(),
  ));
  const timezoneId = text(
    settings.timezone_id,
    settings.timezoneId,
    preset && preset.timezoneId,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    'UTC',
  ) || 'UTC';
  const major = resolveBrowserMajorVersion(settings);
  const os = text(settings.os, 'win11').toLowerCase();
  const userAgent = resolveBrowserUserAgent(settings, os, major);
  const brands = resolveBrowserUaBrands(settings, major);
  return { acceptLanguage: text(settings.accept_language, settings.acceptLanguage, getAcceptLanguage(locale)), brands, locale, major, os, timezoneId, userAgent };
}

function resolvePlatformVersion(settings, os) {
  const defaults = { win11: '15.0.0', win10: '10.0.0', win8: '6.2.0' };
  return text(settings.platform_version, settings.platformVersion, defaults[os], '6.1.0');
}

function resolveFingerprintSettings(settings) {
  const geolocation = settings.geolocation && typeof settings.geolocation === 'object'
    ? settings.geolocation
    : null;
  return { ...settings, geolocation };
}

function buildBrowserProfileFromRegion(regionKey, settings = {}) {
  const preset = getBrowserRegionPreset(regionKey);
  const identity = resolveBrowserIdentity(settings, preset);
  const viewport = settings.viewport && typeof settings.viewport === 'object'
    ? settings.viewport
    : { width: 1366, height: 768 };
  const screen = settings.screen && typeof settings.screen === 'object' ? settings.screen : {
    width: 1366, height: 768, availWidth: 1366, availHeight: 728,
    availLeft: 0, availTop: 0, colorDepth: 24, pixelDepth: 24,
  };
  return {
    browserType: 'chrome',
    browserBrand: 'AI-FREE',
    browserVersion: `${identity.major}.0.0.0`,
    majorVersion: identity.major,
    uaFullVersion: `${identity.major}.0.0.0`,
    region: regionKey || '',
    regionLabel: preset && preset.label || '',
    sourceIp: '',
    sourceCountryCode: '',
    sourceCountry: '',
    sourceRegion: '',
    sourceCity: '',
    geoEndpoint: '',
    locale: identity.locale,
    timezoneId: identity.timezoneId,
    timezoneOffset: getTimezoneOffsetMinutes(identity.timezoneId),
    acceptLanguage: identity.acceptLanguage,
    userAgent: identity.userAgent,
    uaBrands: identity.brands,
    uaFullVersionList: identity.brands.map((item) => ({
      brand: item.brand,
      version: `${String(item.version).split('.')[0]}.0.0.0`,
    })),
    platformVersion: resolvePlatformVersion(settings, identity.os),
    architecture: text(settings.architecture, 'x86') || 'x86',
    bitness: text(settings.bitness, '64') || '64',
    model: text(settings.model),
    wow64: settings.wow64 === true,
    viewport,
    screen,
    colorScheme: text(settings.color_scheme, settings.colorScheme, 'light') || 'light',
    deviceScaleFactor: positiveNumber(firstNonNull(settings.device_scale_factor, settings.deviceScaleFactor), 1, 0.5),
    hardwareConcurrency: positiveNumber(firstNonNull(settings.hardware_concurrency, settings.hardwareConcurrency), 8, 1),
    deviceMemory: positiveNumber(firstNonNull(settings.device_memory, settings.deviceMemory), 8, 1),
    maxTouchPoints: positiveNumber(firstNonNull(settings.max_touch_points, settings.maxTouchPoints), 0, 0),
    navigatorVendor: text(settings.navigator_vendor, settings.navigatorVendor, 'Google Inc.'),
    navigatorPlatform: text(settings.navigator_platform, settings.navigatorPlatform, TAB_PLATFORM),
    webglVendor: text(settings.webgl_vendor, settings.webglVendor, 'Google Inc. (Intel)'),
    webglRenderer: text(settings.webgl_renderer, settings.webglRenderer, 'ANGLE (Intel, Intel(R) Graphics, Direct3D11)'),
    fingerprintSettings: resolveFingerprintSettings(settings),
    languages: Array.from(new Set([identity.locale, identity.locale.split('-')[0], 'en'].filter(Boolean))),
  };
}

async function resolveTabBrowserProfile(options = {}) {
  const settings = options.browserSettings && typeof options.browserSettings === 'object'
    ? options.browserSettings
    : {};
  const explicitRegion = normalizeRegionKey(firstNonNull(
    settings.region,
    settings.browser_region,
    settings.browserRegion,
    '',
  ));
  if (explicitRegion && REGION_PRESETS[explicitRegion]) {
    return buildBrowserProfileFromRegion(explicitRegion, settings);
  }

  const localeRegion = inferBrowserRegionKeyFromLocale(
    firstNonNull(settings.locale, settings.browser_locale, settings.browserLocale, getDefaultLocale()),
  );
  return buildBrowserProfileFromRegion(localeRegion || 'us', settings);
}

module.exports = {
  buildBrowserProfileFromRegion,
  resolveTabBrowserProfile,
};
