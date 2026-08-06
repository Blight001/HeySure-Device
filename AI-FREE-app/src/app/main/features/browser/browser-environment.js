'use strict';

const { parseLaunchArgs } = require('../../utils/ai-free-browser-settings');
const { firstText } = require('../../../shared/safe-values');

/** @typedef {Record<string, any>} BrowserSettingsRecord */

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function copyMode(value, fallback = '') {
  const selected = value || fallback;
  return String(selected || '').trim();
}

function numberOr(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function numberOrNonZero(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric !== 0 ? numeric : fallback;
}

function normalizeBrands(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    brand: firstText(item && item.brand).trim(),
    version: firstText(item && item.version).trim(),
  })).filter((item) => item.brand);
}

function parseCookieCount(value) {
  try {
    const cookies = JSON.parse(firstText(value, '[]'));
    return Array.isArray(cookies) ? cookies.length : 0;
  } catch (_) {
    return 0;
  }
}

function normalizeProxyPort(value) {
  if (value === '' || value === null || value === undefined) return '';
  return Number(value);
}

function createSettingsSections(settings) {
  return {
    proxy: asRecord(settings.proxy), homepage: asRecord(settings.homepage), ua: asRecord(settings.ua),
    secChUa: asRecord(settings.secChUa), language: asRecord(settings.language), timezone: asRecord(settings.timezone),
    webrtc: asRecord(settings.webrtc), geolocation: asRecord(settings.geolocation), resolution: asRecord(settings.resolution),
    fonts: asRecord(settings.fonts), canvas: asRecord(settings.canvas), webglImage: asRecord(settings.webglImage),
    webglMetadata: asRecord(settings.webglMetadata), webgpu: asRecord(settings.webgpu),
    audioContext: asRecord(settings.audioContext), clientRects: asRecord(settings.clientRects),
    speechVoices: asRecord(settings.speechVoices), deviceName: asRecord(settings.deviceName),
    macAddress: asRecord(settings.macAddress), portScanProtection: asRecord(settings.portScanProtection),
    launchArgs: asRecord(settings.launchArgs),
  };
}

/** @param {BrowserSettingsRecord} [browserSettings] */
function resolveChromiumExtensionPaths(browserSettings = {}, extensionManager = null) {
  const configuredExtensionPaths = Array.isArray(browserSettings.chromiumExtensionPaths)
    ? browserSettings.chromiumExtensionPaths
    : [];
  const managedExtensionPaths = extensionManager
    && typeof extensionManager.getEnabledExtensionPaths === 'function'
    ? extensionManager.getEnabledExtensionPaths()
    : [];
  return Array.from(new Set(
    [...managedExtensionPaths, ...configuredExtensionPaths]
      .map((item) => String(item || '').trim())
      .filter((item) => item && !/[\\/]browser_automation(?:[\\/]|$)/i.test(item)),
  ));
}

/** @param {BrowserSettingsRecord} [browserSettings] */
function resolveConfiguredBrowserProxy(browserSettings = {}) {
  const proxy = asRecord(browserSettings.proxy);
  if (proxy.mode === 'default') return null;
  if (proxy.mode === 'none') return { enabled: false };
  const host = firstText(proxy.host).trim();
  const port = Number(proxy.port);
  if (proxy.mode !== 'custom' || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { enabled: false };
  }
  const protocol = firstText(proxy.protocol, 'http').toLowerCase();
  return {
    enabled: true,
    protocol,
    server: `${protocol}://${host}:${port}`,
    bypassRules: '<local>;127.0.0.1;localhost;::1',
    username: firstText(proxy.username),
    password: firstText(proxy.password),
  };
}

/** @param {BrowserSettingsRecord} [browserSettings] */
function resolveConfiguredHomepage(browserSettings = {}, fallback = '') {
  const homepage = browserSettings.homepage && typeof browserSettings.homepage === 'object' ? browserSettings.homepage : {};
  return homepage.mode === 'custom' && String(homepage.url || '').trim()
    ? String(homepage.url).trim()
    : fallback;
}

/** @param {BrowserSettingsRecord} [browserSettings] */
function resolveChromiumExtraArgs(browserSettings = {}) {
  const args = parseLaunchArgs(browserSettings);
  if (browserSettings.hardwareAcceleration === false && !args.includes('--disable-gpu')) args.push('--disable-gpu');
  return args;
}

/** @param {BrowserSettingsRecord} [profile] */
function buildAppliedBrowserEnvironment(profile = {}) {
  if (!profile || typeof profile !== 'object') return null;
  return {
    browserBrand: firstText(profile.browserBrand).trim(),
    browserType: firstText(profile.browserType).trim(),
    browserVersion: firstText(profile.browserVersion).trim(),
    majorVersion: firstText(profile.majorVersion).trim(),
    region: firstText(profile.region).trim(),
    regionLabel: firstText(profile.regionLabel).trim(),
    sourceIp: firstText(profile.sourceIp).trim(),
    sourceCountryCode: firstText(profile.sourceCountryCode).trim(),
    sourceCountry: firstText(profile.sourceCountry).trim(),
    sourceRegion: firstText(profile.sourceRegion).trim(),
    sourceCity: firstText(profile.sourceCity).trim(),
    locale: firstText(profile.locale).trim(),
    timezoneId: firstText(profile.timezoneId).trim(),
    acceptLanguage: firstText(profile.acceptLanguage).trim(),
    userAgent: firstText(profile.userAgent).trim(),
    uaBrands: normalizeBrands(profile.uaBrands),
  };
}

/** @param {BrowserSettingsRecord} [settings] */
function buildAppliedBrowserSettings(settings = {}) {
  if (!settings || typeof settings !== 'object') return null;
  const {
    proxy, homepage, ua, secChUa, language, timezone, webrtc, geolocation, resolution,
    fonts, canvas, webglImage, webglMetadata, webgpu, audioContext, clientRects,
    speechVoices, deviceName, macAddress, portScanProtection, launchArgs,
  } = createSettingsSections(settings);
  return {
    os: copyMode(settings.os, 'win11'),
    browserVersion: copyMode(settings.browserVersion),
    kernelVersion: copyMode(settings.kernelVersion, 'auto'),
    proxy: {
      mode: copyMode(proxy.mode, 'default'),
      protocol: copyMode(proxy.protocol, 'http'),
      host: copyMode(proxy.host),
      port: normalizeProxyPort(proxy.port),
      authenticationConfigured: Boolean(firstText(proxy.username, proxy.password).trim()),
      apiConfigured: Boolean(firstText(proxy.apiUrl).trim()),
    },
    cookieCount: parseCookieCount(settings.cookies),
    homepage: { mode: copyMode(homepage.mode, 'default'), url: copyMode(homepage.url) },
    ua: { mode: copyMode(ua.mode, 'default') },
    secChUa: {
      mode: copyMode(secChUa.mode, 'default'),
      brands: normalizeBrands(secChUa.brands),
    },
    language: { mode: 'custom', value: copyMode(language.value) },
    timezone: { mode: copyMode(timezone.mode, 'ip'), value: copyMode(timezone.value) },
    webrtc: { mode: copyMode(webrtc.mode, 'replace') },
    geolocation: {
      permission: copyMode(geolocation.permission, 'ask'),
      mode: copyMode(geolocation.mode, 'ip'),
      longitude: numberOr(geolocation.longitude, 0),
      latitude: numberOr(geolocation.latitude, 0),
      accuracy: Math.max(1, numberOrNonZero(geolocation.accuracy, 100)),
    },
    resolution: {
      mode: copyMode(resolution.mode, 'follow'),
      width: Math.max(0, numberOr(resolution.width, 0)),
      height: Math.max(0, numberOr(resolution.height, 0)),
    },
    fonts: { mode: copyMode(fonts.mode, 'system') },
    canvas: { mode: copyMode(canvas.mode, 'default') },
    webglImage: { mode: copyMode(webglImage.mode, 'default') },
    webglMetadata: {
      mode: copyMode(webglMetadata.mode, 'default'),
      vendor: copyMode(webglMetadata.vendor),
      renderer: copyMode(webglMetadata.renderer),
    },
    webgpu: { mode: copyMode(webgpu.mode, 'default') },
    audioContext: { mode: copyMode(audioContext.mode, 'default') },
    clientRects: { mode: copyMode(clientRects.mode, 'default') },
    speechVoices: { mode: copyMode(speechVoices.mode, 'default') },
    cpu: Math.max(1, numberOr(settings.cpu, 1)),
    memory: Math.max(1, numberOr(settings.memory, 1)),
    deviceName: { mode: copyMode(deviceName.mode, 'default'), value: copyMode(deviceName.value) },
    macAddress: { mode: copyMode(macAddress.mode, 'default'), value: copyMode(macAddress.value) },
    doNotTrack: settings.doNotTrack === true,
    sslEnabled: settings.sslEnabled === true,
    portScanProtection: {
      enabled: portScanProtection.enabled === true,
      allowList: Array.isArray(portScanProtection.allowList)
        ? portScanProtection.allowList.map((item) => Number(item)).filter(Number.isFinite)
        : [],
    },
    hardwareAcceleration: settings.hardwareAcceleration !== false,
    launchArgs: {
      mode: copyMode(launchArgs.mode, 'default'),
      value: copyMode(launchArgs.value),
    },
  };
}

function buildBrowserStatusPageUrl(title, message, tone = 'loading') {
  const safeTitle = String(title || '新建窗口').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  const safeMessage = String(message || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  const isError = tone === 'error';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title><style>
    :root{color-scheme:dark}html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#0f1115;color:#e6e8ee;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{text-align:center;padding:28px}.spinner{width:34px;height:34px;margin:0 auto 18px;border:3px solid rgba(77,163,255,.2);border-top-color:${isError ? '#e06666' : '#4da3ff'};border-radius:50%;animation:spin .8s linear infinite}.error .spinner{animation:none;border-color:#e06666}.title{font-size:18px;font-weight:700}.message{margin-top:8px;color:#9aa3b2;font-size:13px}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><div class="card${isError ? ' error' : ''}"><div class="spinner"></div><div class="title">${safeTitle}</div><div class="message">${safeMessage}</div></div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

module.exports = {
  buildAppliedBrowserEnvironment,
  buildAppliedBrowserSettings,
  buildBrowserStatusPageUrl,
  resolveChromiumExtensionPaths,
  resolveChromiumExtraArgs,
  resolveConfiguredBrowserProxy,
  resolveConfiguredHomepage,
};
