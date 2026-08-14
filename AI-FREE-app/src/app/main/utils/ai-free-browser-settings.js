const crypto = require('crypto');

const DEFAULT_AI_FREE_BROWSER_SETTINGS = Object.freeze({
  os: 'win11',
  browserVersion: '',
  kernelVersion: 'auto',
  proxy: { mode: 'default', protocol: 'http', host: '', port: '', username: '', password: '', apiUrl: '' },
  cookies: '[]',
  homepage: { mode: 'default', url: '' },
  ua: { mode: 'default', value: '' },
  secChUa: { mode: 'default', brands: [] },
  language: { mode: 'custom', value: '' },
  timezone: { mode: 'ip', value: '' },
  webrtc: { mode: 'replace' },
  geolocation: { permission: 'ask', mode: 'ip', longitude: 0, latitude: 0, accuracy: 100 },
  resolution: { mode: 'follow', width: 1366, height: 768 },
  fonts: { mode: 'system', seed: '' },
  canvas: { mode: 'noise', seed: '' },
  webglImage: { mode: 'noise', seed: '' },
  webglMetadata: {
    mode: 'custom',
    vendor: 'Google Inc. (Intel)',
    renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  webgpu: { mode: 'webgl' },
  audioContext: { mode: 'noise', seed: '' },
  clientRects: { mode: 'noise', seed: '' },
  speechVoices: { mode: 'noise', seed: '' },
  cpu: 8,
  memory: 8,
  deviceName: { mode: 'default', value: '' },
  macAddress: { mode: 'default', value: '' },
  doNotTrack: false,
  sslEnabled: false,
  portScanProtection: { enabled: true, allowList: [] },
  hardwareAcceleration: true,
  lowSpecMode: 'auto',
  launchArgs: { mode: 'default', value: '' },
  automation: { permissionOrigins: [] },
});

const pick = (value, allowed, fallback) => allowed.includes(String(value || '').toLowerCase())
  ? String(value).toLowerCase()
  : fallback;
const text = (value, fallback = '', max = 2048) => (String(value ?? '').trim() || fallback).slice(0, max);
const num = (value, fallback, min, max, integer = false) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const result = Math.max(min, Math.min(max, parsed));
  return integer ? Math.round(result) : result;
};
const bool = (value, fallback = false) => typeof value === 'boolean' ? value : fallback;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const seed = (value) => text(value, crypto.randomBytes(8).toString('hex'), 64);

function normalizeBrands(value) {
  const list = Array.isArray(value) ? value : [];
  return list.slice(0, 8).map((item) => ({
    brand: text(item?.brand, '', 80),
    version: text(item?.version, '', 30),
  })).filter((item) => item.brand && item.version);
}

function normalizeCookies(value) {
  if (Array.isArray(value)) return JSON.stringify(value, null, 2).slice(0, 200000);
  return text(value, '[]', 200000);
}

function normalizeProxyPort(value) {
  return value === '' || value == null ? '' : num(value, '', 1, 65535, true);
}

function normalizePortAllowList(value) {
  const list = Array.isArray(value) ? value : text(value).split(/[\s,;]+/);
  return list.map((item) => num(item, null, 1, 65535, true)).filter(Boolean).slice(0, 100);
}

function normalizePermissionOriginValues(value) {
  const list = Array.isArray(value) ? value : text(value).split(/[\s,;]+/);
  return list.map((item) => text(item, '', 2048)).filter(Boolean).slice(0, 64);
}

function normalizeAutomationSettings(source) {
  const automation = object(source.automation);
  return {
    permissionOrigins: normalizePermissionOriginValues(
      automation.permissionOrigins ?? source.autoGrantPermissionOrigins,
    ),
  };
}

function applyFlatBrowserSettingAliases(normalized, width, height) {
  normalized.userAgent = normalized.ua.mode === 'custom' ? normalized.ua.value : '';
  normalized.locale = normalized.language.value;
  normalized.timezoneId = normalized.timezone.mode === 'custom' ? normalized.timezone.value : '';
  normalized.acceptLanguage = normalized.locale ? `${normalized.locale},${normalized.locale.split('-')[0]};q=0.9,en;q=0.8` : '';
  normalized.hardwareConcurrency = normalized.cpu;
  normalized.deviceMemory = normalized.memory;
  normalized.webglVendor = normalized.webglMetadata.vendor;
  normalized.webglRenderer = normalized.webglMetadata.renderer;
  normalized.viewport = { width, height };
  normalized.screen = { width, height, availWidth: width, availHeight: Math.max(560, height - 40), colorDepth: 24, pixelDepth: 24 };
  return normalized;
}

function normalizeAiFreeBrowserSettings(input = {}) {
  const source = object(input), defaults = DEFAULT_AI_FREE_BROWSER_SETTINGS;
  const proxy = object(source.proxy);
  const homepage = object(source.homepage);
  const ua = object(source.ua);
  const secChUa = object(source.secChUa);
  const language = object(source.language);
  const timezone = object(source.timezone);
  const webrtc = object(source.webrtc);
  const geolocation = object(source.geolocation);
  const resolution = object(source.resolution);
  const fonts = object(source.fonts);
  const canvas = object(source.canvas);
  const webglImage = object(source.webglImage);
  const webglMetadata = object(source.webglMetadata);
  const webgpu = object(source.webgpu);
  const audioContext = object(source.audioContext);
  const clientRects = object(source.clientRects);
  const speechVoices = object(source.speechVoices);
  const deviceName = object(source.deviceName);
  const macAddress = object(source.macAddress);
  const portScanProtection = object(source.portScanProtection);
  const launchArgs = object(source.launchArgs);
  const width = num(resolution.width ?? source.screen?.width, defaults.resolution.width, 800, 7680, true);
  const height = num(resolution.height ?? source.screen?.height, defaults.resolution.height, 600, 4320, true);
  const normalized = {
    os: pick(source.os, ['win7', 'win8', 'win10', 'win11'], defaults.os),
    browserVersion: text(source.browserVersion, '', 30).replace(/[^0-9.]/g, ''),
    kernelVersion: text(source.kernelVersion, 'auto', 60),
    proxy: {
      // 旧版本持久化的 magic 模式会回落为 default；网络魔法现为应用级独立开关。
      mode: pick(proxy.mode, ['default', 'none', 'custom'], defaults.proxy.mode),
      protocol: pick(proxy.protocol, ['http', 'https', 'socks4', 'socks5'], defaults.proxy.protocol),
      host: text(proxy.host, '', 255),
      port: normalizeProxyPort(proxy.port),
      username: text(proxy.username, '', 255),
      password: text(proxy.password, '', 1024),
      apiUrl: text(proxy.apiUrl, '', 2048),
    },
    cookies: normalizeCookies(source.cookies),
    homepage: { mode: pick(homepage.mode, ['default', 'custom'], defaults.homepage.mode), url: text(homepage.url, '', 2048) },
    ua: { mode: pick(ua.mode, ['default', 'custom'], defaults.ua.mode), value: text(ua.value ?? source.userAgent, '', 2048) },
    secChUa: { mode: pick(secChUa.mode, ['default', 'custom'], defaults.secChUa.mode), brands: normalizeBrands(secChUa.brands) },
    // 旧版 ip 模式只保留用户输入值；语言不再与地区或出口 IP 绑定。
    language: { mode: 'custom', value: text(language.value ?? source.locale, '', 80) },
    timezone: { mode: pick(timezone.mode, ['ip', 'custom'], defaults.timezone.mode), value: text(timezone.value ?? source.timezoneId, '', 100) },
    webrtc: { mode: pick(webrtc.mode, ['replace', 'allow', 'block'], defaults.webrtc.mode) },
    geolocation: {
      permission: pick(geolocation.permission, ['ask', 'allow', 'block'], defaults.geolocation.permission),
      mode: pick(geolocation.mode, ['ip', 'custom'], defaults.geolocation.mode),
      longitude: num(geolocation.longitude, 0, -180, 180), latitude: num(geolocation.latitude, 0, -90, 90),
      accuracy: num(geolocation.accuracy, 100, 1, 100000),
    },
    resolution: { mode: pick(resolution.mode, ['follow', 'custom'], defaults.resolution.mode), width, height },
    fonts: { mode: pick(fonts.mode, ['system', 'random'], defaults.fonts.mode), seed: seed(fonts.seed) },
    canvas: { mode: pick(canvas.mode, ['default', 'noise'], defaults.canvas.mode), seed: seed(canvas.seed) },
    webglImage: { mode: pick(webglImage.mode, ['default', 'noise'], defaults.webglImage.mode), seed: seed(webglImage.seed) },
    webglMetadata: {
      mode: pick(webglMetadata.mode, ['default', 'custom'], defaults.webglMetadata.mode),
      vendor: text(webglMetadata.vendor ?? source.webglVendor, defaults.webglMetadata.vendor, 300),
      renderer: text(webglMetadata.renderer ?? source.webglRenderer, defaults.webglMetadata.renderer, 800),
    },
    webgpu: { mode: pick(webgpu.mode, ['default', 'webgl'], defaults.webgpu.mode) },
    audioContext: { mode: pick(audioContext.mode, ['default', 'noise'], defaults.audioContext.mode), seed: seed(audioContext.seed) },
    clientRects: { mode: pick(clientRects.mode, ['default', 'noise'], defaults.clientRects.mode), seed: seed(clientRects.seed) },
    speechVoices: { mode: pick(speechVoices.mode, ['default', 'noise'], defaults.speechVoices.mode), seed: seed(speechVoices.seed) },
    cpu: num(source.cpu ?? source.hardwareConcurrency, defaults.cpu, 1, 64, true),
    memory: num(source.memory ?? source.deviceMemory, defaults.memory, 1, 64, true),
    deviceName: { mode: pick(deviceName.mode, ['default', 'custom'], defaults.deviceName.mode), value: text(deviceName.value, '', 80) },
    macAddress: { mode: pick(macAddress.mode, ['default', 'custom'], defaults.macAddress.mode), value: text(macAddress.value, '', 32).toUpperCase() },
    doNotTrack: bool(source.doNotTrack, defaults.doNotTrack),
    sslEnabled: bool(source.sslEnabled, defaults.sslEnabled),
    portScanProtection: {
      enabled: bool(portScanProtection.enabled, defaults.portScanProtection.enabled),
      allowList: normalizePortAllowList(portScanProtection.allowList),
    },
    ...normalizeRuntimePolicy(source, defaults),
    launchArgs: { mode: pick(launchArgs.mode, ['default', 'custom'], defaults.launchArgs.mode), value: text(launchArgs.value, '', 10000) },
    automation: normalizeAutomationSettings(source),
  };

  return applyFlatBrowserSettingAliases(normalized, width, height);
}

function parseCookieJson(settings = {}) {
  try {
    const parsed = JSON.parse(String(settings.cookies || '[]'));
    return Array.isArray(parsed) ? parsed.slice(0, 5000) : [];
  } catch (_) {
    return [];
  }
}

function parseLaunchArgs(settings = {}) {
  if (settings.launchArgs?.mode !== 'custom') return [];
  return String(settings.launchArgs.value || '').split(/\r?\n|\s+(?=--)/).map((item) => item.trim()).filter((item) => item.startsWith('--')).slice(0, 100);
}

function normalizeRuntimePolicy(source, defaults) {
  return {
    hardwareAcceleration: bool(source.hardwareAcceleration, defaults.hardwareAcceleration),
    lowSpecMode: pick(source.lowSpecMode, ['auto', 'on', 'off'], defaults.lowSpecMode),
  };
}

module.exports = {
  DEFAULT_AI_FREE_BROWSER_SETTINGS,
  normalizeAiFreeBrowserSettings,
  parseCookieJson,
  parseLaunchArgs,
};
