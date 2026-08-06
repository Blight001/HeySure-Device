'use strict';

const { app: electronApp } = require('electron');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { getCoreDir } = require('../../config');
const {
  copyDirectoryRecursive,
  copyDirectoryRecursiveAsync,
  getClashMiniAppRoots,
  getClashMiniCoreRoots,
  resolveBundledClashMiniCoreDir,
  getClashMiniRuntimeRoot,
  resolveClashMiniCoreDir,
  resolveClashMiniExecutable,
  getLocalAssetRelativePaths,
  buildLocalAssetManifest,
  readLocalAssetMarker,
  writeLocalAssetMarker,
  writeLocalAssetMarkerAsync,
  isLocalAssetSizeCurrent,
  syncLocalGeoAssets,
  syncLocalGeoAssetsAsync,
  prepareClashMiniRuntimeDirAsync,
  purgeClashMiniRuntimeConfigFiles,
} = require('./clash-mini-assets');
const {
  parseYamlMaybe,
  looksLikeRuntimeClashConfig,
  looksLikeProfilesIndex,
  readYamlIfExists,
  readClashMiniRuntimeConfig,
  getClashMiniProxyEndpoint,
  getClashMiniControlEndpoint,
  getClashMiniControlSecret,
  getClashMiniManualGroupName,
  getClashMiniConfigProxyNames,
  buildClashMiniControlUrl,
  buildClashMiniControlHeaders,
  extractDelayValue,
  normalizeProxyNameList,
  fetchClashMiniProxyNames,
  probeClashMiniProxyDelay,
  probeClashMiniGroupDelay,
  formatClashMiniDelayText,
  collectClashMiniProxyDelays,
  normalizeProbeTimeout,
  normalizeProbeUrl,
  readClashProbeSettings,
  probeLatencyUrl,
  waitForClashMiniControlApi,
  invokeClashMiniControl,
  ensureClashMiniRuleMode,
} = require('./clash-mini-control');

const {
  ensureClashMiniControlFields,
  normalizeClashMiniStartupConfig,
  getClashMiniCompatibilitySummary,
} = require('./clash-mini-geo-config');

function extractDirectClashConfigContent(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    const trimmed = value.replace(/^\uFEFF/, '').trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('---')) return trimmed;
    if (/^(proxies|proxy-groups|rules|port|mixed-port|external-controller)\s*:/m.test(trimmed)) {
      return trimmed;
    }
    try {
      const parsed = JSON.parse(trimmed);
      const nested = getFirstStringField(parsed, ['config', 'data', 'content']);
      if (nested) return nested;
    } catch (_) {}
    return trimmed;
  }
  return getFirstStringField(value, [
    'clashConfig', 'clash_config', 'config', 'data', 'content', 'configContent',
    'yaml_content', 'yamlContent', 'profiles_yaml_content', 'red_yaml_content',
  ]);
}

function getFirstStringField(value, keys) {
  if (!value || typeof value !== 'object') return '';
  const key = keys.find((candidate) => typeof value[candidate] === 'string');
  return key ? value[key] : '';
}

function tryDecodeBase64Text(text) {
  const raw = String(text || '').replace(/\s+/g, '');
  if (!raw || raw.length < 32 || raw.length % 4 !== 0) {
    return '';
  }

  if (!/^[A-Za-z0-9+/=]+$/.test(raw)) {
    return '';
  }

  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8').replace(/^\uFEFF/, '').trim();
    if (!decoded) return '';
    if (/[\uFFFD]/.test(decoded)) return '';
    return decoded;
  } catch (_) {
    return '';
  }
}

function looksLikeSubscriptionPayload(text) {
  const value = String(text || '').trim();
  return /^(vmess|vless|trojan|ss|ssr):\/\//im.test(value);
}

function decodeSubscriptionItemName(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch (_) {
    return raw;
  }
}

function safeBase64UrlDecode(input) {
  const raw = String(input || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!raw) return '';
  const padded = raw + '='.repeat((4 - (raw.length % 4)) % 4);
  try {
    return Buffer.from(padded, 'base64').toString('utf8').replace(/^\uFEFF/, '').trim();
  } catch (_) {
    return '';
  }
}

function sanitizeProxyName(name, fallback) {
  const value = decodeSubscriptionItemName(name || fallback || '').replace(/\s+/g, ' ').trim();
  return value || String(fallback || 'proxy').trim() || 'proxy';
}

function parseVmessSubscriptionLine(line, index) {
  const raw = String(line || '').trim();
  if (!raw.startsWith('vmess://')) return null;

  const payload = safeBase64UrlDecode(raw.slice('vmess://'.length));
  if (!payload) return null;

  const json = parseJsonObject(payload);
  if (!json) return null;
  const identity = getVmessIdentity(json, index);
  if (!identity) return null;
  const transport = getVmessTransport(json);
  const tlsEnabled = ['1', 'true', 'tls', 'on', 'yes'].includes(String(json.tls || '').trim().toLowerCase());
  const proxy = createVmessProxy(json, identity, tlsEnabled);
  applyVmessSecurity(proxy, json, transport, tlsEnabled);
  applyVmessTransport(proxy, transport);
  return proxy;
}

function getVmessIdentity(json, index) {
  const server = String(json.add || json.server || '').trim();
  const port = Number(json.port);
  const uuid = String(json.id || json.uuid || '').trim();
  if (!server || !Number.isFinite(port) || port <= 0 || !uuid) return null;
  return { server, port, uuid, fallbackName: `${server}:${port}-${index + 1}` };
}

function createVmessProxy(json, identity, tlsEnabled) {
  return {
    name: sanitizeProxyName(json.ps, identity.fallbackName),
    type: 'vmess',
    server: identity.server,
    port: identity.port,
    uuid: identity.uuid,
    alterId: Number.isFinite(Number(json.aid)) ? Number(json.aid) : 0,
    cipher: String(json.cipher || 'auto').trim() || 'auto',
    udp: json.udp !== false,
    tls: tlsEnabled,
  };
}

function applyVmessSecurity(proxy, json, transport, tlsEnabled) {
  const servername = String(json.sni || json.servername || transport.host || proxy.server).trim();
  if (tlsEnabled && servername) proxy.servername = servername;
  const skipVerify = String(json.skip_cert_verify || '').toLowerCase() === 'true'
    || json.skipCertVerify === true;
  if (skipVerify) proxy['skip-cert-verify'] = true;
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (_) {
    return null;
  }
}

function getVmessTransport(json) {
  return {
    network: String(json.net || 'tcp').trim().toLowerCase(),
    host: String(json.host || json.headers?.Host || '').trim(),
    path: String(json.path || '').trim(),
  };
}

function applyVmessTransport(proxy, { network, host, path: pathValue }) {
  if (network === 'ws') {
    proxy.network = 'ws';
    proxy['ws-opts'] = { path: pathValue || '/', ...(host ? { headers: { Host: host } } : {}) };
    return;
  }
  if (['h2', 'http'].includes(network)) {
    proxy.network = 'http';
    proxy['http-opts'] = { path: pathValue ? [pathValue] : ['/'], ...(host ? { headers: { Host: host } } : {}) };
    return;
  }
  if (network === 'grpc') {
    proxy.network = 'grpc';
    proxy['grpc-opts'] = { 'grpc-service-name': pathValue.replace(/^\//, '') };
    return;
  }
  if (network && network !== 'tcp') proxy.network = network;
}

function parseSubscriptionProxyList(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];

  const lines = raw
    .split(/\r?\n/)
    .map((line) => String(line || '').trim())
    .filter((line) => line && !line.startsWith('#'));

  const proxies = [];
  lines.forEach((line, index) => {
    const proxy = parseVmessSubscriptionLine(line, index);
    if (proxy) {
      proxies.push(proxy);
    }
  });
  return proxies;
}

function buildClashRuntimeConfigFromSubscription(text) {
  const content = String(text || '').trim();
  const decodedBase64 = tryDecodeBase64Text(content);
  const subscriptionText = looksLikeSubscriptionPayload(content)
    ? content
    : (looksLikeSubscriptionPayload(decodedBase64) ? decodedBase64 : '');
  if (!subscriptionText) {
    return null;
  }

  const proxies = parseSubscriptionProxyList(subscriptionText);
  if (!proxies.length) {
    return null;
  }

  const proxyNames = proxies.map((item) => item.name).filter(Boolean);
  return {
    port: 7890,
    'socks-port': 7891,
    'mixed-port': 7890,
    mode: 'rule',
    'log-level': 'info',
    'allow-lan': true,
    'external-controller': '127.0.0.1:9090',
    proxies,
    'proxy-groups': [
      {
        name: '节点选择',
        type: 'select',
        proxies: [...proxyNames, 'DIRECT'],
      },
    ],
    rules: ['MATCH,节点选择'],
  };
}

function normalizeDirectClashRuntimeConfig(rawContent, options = {}) {
  const text = extractDirectClashConfigContent(rawContent);
  if (!text) {
    return { ok: false, error: '空的 Clash 配置内容', rawContent: '' };
  }
  const direct = normalizeParsedClashContent(text, options.coreDir);
  if (direct) return direct;

  const decodedBase64 = tryDecodeBase64Text(text);
  if (decodedBase64) {
    const decoded = normalizeParsedClashContent(decodedBase64, options.coreDir);
    if (decoded) return decoded;
  }
  const converted = normalizeSubscriptionContent(text);
  if (converted) return converted;

  return { ok: false, error: 'Clash 配置解析失败', rawContent: text };
}

function normalizeParsedClashContent(text, coreDir) {
  try {
    const parsed = YAML.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const normalized = normalizeClashMiniStartupConfig(parsed, coreDir);
      return {
        ok: true,
        content: YAML.stringify(normalized.config),
        rawContent: text,
        compatibility: getClashMiniCompatibilitySummary(normalized),
      };
    }
    if (typeof parsed === 'string') return normalizeSubscriptionContent(parsed);
  } catch (_) {}
  return normalizeSubscriptionContent(text);
}

function normalizeSubscriptionContent(text) {
  const converted = buildClashRuntimeConfigFromSubscription(text);
  return converted ? { ok: true, content: YAML.stringify(converted), rawContent: text } : null;
}

function importDirectClashRuntimeConfig(coreDir, payload, sourceLabel = 'server-config') {
  // 服务器配置可能在 Mihomo 首次启动前导入；必须先同步资产再规范化，
  // 否则缺 Geo 的离线兜底会提前把 MATCH,节点组 固化成 MATCH,DIRECT。
  const assetSync = syncLocalGeoAssets(coreDir);
  if (!assetSync.ok) {
    const details = assetSync.missing.length > 0
      ? assetSync.missing.join(', ')
      : (assetSync.error || '未知错误');
    console.warn(`[IPC] Clash Mini 本地 Geo/规则资产缺失: ${details}（将回退到离线兜底）`);
  }
  const rawContent = extractDirectClashConfigContent(payload);
  const normalized = normalizeDirectClashRuntimeConfig(rawContent, { coreDir });
  if (!normalized.ok) {
    return {
      ...normalized,
      rawContent,
    };
  }

  try {
    const runtimeConfigPath = path.join(coreDir, 'config.yaml');
    fs.mkdirSync(coreDir, { recursive: true });
    const purgeResult = purgeClashMiniRuntimeConfigFiles(coreDir);
    fs.writeFileSync(runtimeConfigPath, normalized.content, 'utf8');
    const generatedPreview = String(normalized.content || '').replace(/\s+/g, ' ').trim().slice(0, 360);
    return {
      ok: true,
      runtimeConfigPath,
      source: sourceLabel,
      refreshed: true,
      purgeResult,
      generatedPreview,
      generatedContent: normalized.content,
    };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

module.exports = {
  extractDirectClashConfigContent,
  tryDecodeBase64Text,
  looksLikeSubscriptionPayload,
  decodeSubscriptionItemName,
  safeBase64UrlDecode,
  sanitizeProxyName,
  parseVmessSubscriptionLine,
  parseSubscriptionProxyList,
  buildClashRuntimeConfigFromSubscription,
  normalizeDirectClashRuntimeConfig,
  importDirectClashRuntimeConfig,
};
