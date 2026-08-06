'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { readStoreConfigSafe } = require('../../ipc/register/store-utils');
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

const { CLASH_MINI_RULE_MODE } = require('./clash-mini-constants');
const {
  normalizeProbeTimeout,
  normalizeProbeUrl,
  readClashProbeSettings,
  probeLatencyUrl,
} = require('./clash-mini-latency-probe');

function parseYamlMaybe(value) {
  if (typeof value === 'string') {
    try {
      return YAML.parse(value);
    } catch (_) {
      return null;
    }
  }
  return value && typeof value === 'object' ? value : null;
}

function looksLikeRuntimeClashConfig(value) {
  const parsed = parseYamlMaybe(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  return Array.isArray(parsed.proxies)
    || Array.isArray(parsed['proxy-groups'])
    || Array.isArray(parsed.rules)
    || typeof parsed['mixed-port'] !== 'undefined'
    || typeof parsed.port !== 'undefined'
    || typeof parsed['external-controller'] !== 'undefined';
}

function looksLikeProfilesIndex(value) {
  const parsed = parseYamlMaybe(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  if (Array.isArray(parsed.items) || typeof parsed.current !== 'undefined' || typeof parsed.getCurrentProfile !== 'undefined') {
    return true;
  }
  if (typeof parsed.uid === 'string' && typeof parsed.type === 'string' && typeof parsed.file === 'string') {
    return true;
  }
  return false;
}

function readYamlIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return YAML.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

// config.yaml/self.yaml 会被端点、密钥、分组等多个读取器在测速轮询等热路径里反复
// 读取。按文件 mtime+size 缓存解析结果，避免每次控制请求都重新读盘并解析整份配置。
const clashMiniRuntimeConfigCache = new Map();

function readClashMiniRuntimeConfig(coreDir) {
  if (!coreDir) return {};
  const cached = clashMiniRuntimeConfigCache.get(coreDir);
  for (const fileName of ['config.yaml', 'self.yaml']) {
    const filePath = path.join(coreDir, fileName);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (_) {
      continue;
    }
    if (cached
      && cached.filePath === filePath
      && cached.mtimeMs === stat.mtimeMs
      && cached.size === stat.size) {
      return cached.value;
    }
    let parsed = null;
    try {
      parsed = YAML.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      clashMiniRuntimeConfigCache.set(coreDir, {
        filePath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        value: parsed,
      });
      return parsed;
    }
  }
  clashMiniRuntimeConfigCache.delete(coreDir);
  return {};
}

function getClashMiniProxyEndpoint(coreDir) {
  const config = readClashMiniRuntimeConfig(coreDir);
  const host = '127.0.0.1';
  const mixedPort = Number(config['mixed-port'] || config.mixed_port);
  const httpPort = Number(config.port || config.http_port);
  const socksPort = Number(config['socks-port'] || config.socks_port);
  const port = [mixedPort, httpPort, socksPort, 7890].find((n) => Number.isFinite(n) && n > 0) || 7890;
  return { host, port };
}

function getClashMiniControlEndpoint(coreDir) {
  const config = readClashMiniRuntimeConfig(coreDir);
  const raw = String(config['external-controller'] || config.external_controller || '').trim();
  const [hostPart, portPart] = raw.split(':');
  const host = hostPart || '127.0.0.1';
  const port = Number(portPart);
  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 9090,
  };
}

function getClashMiniControlSecret(coreDir) {
  const config = readClashMiniRuntimeConfig(coreDir);
  return String(config.secret || config['control-secret'] || '').trim();
}

function getClashMiniManualGroupName(coreDir) {
  const config = readClashMiniRuntimeConfig(coreDir);
  const groups = Array.isArray(config['proxy-groups']) ? config['proxy-groups'] : [];
  const manualGroup = groups.find((group) => group && group.type === 'select' && group.name);
  return manualGroup?.name || groups[0]?.name || '节点选择';
}

function getClashMiniConfigProxyNames(coreDir) {
  const config = readClashMiniRuntimeConfig(coreDir);
  return Array.isArray(config.proxies)
    ? config.proxies.map((item) => String(item?.name || '').trim()).filter(Boolean)
    : [];
}

function buildClashMiniControlUrl(coreDir, pathname) {
  const endpoint = getClashMiniControlEndpoint(coreDir);
  const cleanPath = String(pathname || '').startsWith('/') ? String(pathname || '') : `/${String(pathname || '')}`;
  return `http://${endpoint.host}:${endpoint.port}${cleanPath}`;
}

function buildClashMiniControlHeaders(coreDir) {
  const secret = getClashMiniControlSecret(coreDir);
  const headers = {};
  if (secret) {
    headers.Authorization = `Bearer ${secret}`;
  }
  return headers;
}

function parseNonNegativeDelay(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const match = value.match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function extractDelayValue(value) {
  const direct = parseNonNegativeDelay(value);
  if (direct != null) return direct;
  if (!value || typeof value !== 'object') return null;
  for (const candidate of [value.delay, value.latency, value.history]) {
    const parsed = extractDelayValue(candidate);
    if (parsed != null) return parsed;
  }
  return null;
}

function normalizeProxyNameList(input) {
  const out = [];
  const seen = new Set();
  const push = (name) => {
    const value = String(name || '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };

  const walk = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value === 'string' || typeof value === 'number') {
      push(value);
      return;
    }
    if (typeof value === 'object') {
      if (Array.isArray(value.all)) value.all.forEach(walk);
      if (Array.isArray(value.proxies)) value.proxies.forEach(walk);
      if (Array.isArray(value.nodes)) value.nodes.forEach(walk);
      if (value.name) push(value.name);
      if (value.now && typeof value.now === 'string') push(value.now);
      for (const [key, nested] of Object.entries(value)) {
        if (['all', 'proxies', 'nodes', 'name', 'now', 'type', 'history'].includes(key)) continue;
        walk(nested);
      }
    }
  };

  walk(input);
  return out;
}

async function fetchClashMiniGroup(coreDir, groupName) {
  try {
    return await invokeClashMiniControl(coreDir, 'get', `/proxies/${encodeURIComponent(groupName)}`, {
      timeoutMs: 15000,
    });
  } catch (error) {
    console.warn('[IPC] 获取 Clash Mini 节点列表失败，改用本地配置兜底:', error?.message || error);
    return null;
  }
}

async function resolveClashMiniCurrentProxy(coreDir, currentName, configNameSet) {
  let current = currentName;
  // A select group may currently point at a nested url-test/select group.
  // Resolve that chain for UI highlighting, but never expose the group name
  // itself as if it were a real proxy node.
  const visited = new Set();
  while (current && !configNameSet.has(current) && !visited.has(current)) {
    visited.add(current);
    try {
      const nested = await invokeClashMiniControl(coreDir, 'get', `/proxies/${encodeURIComponent(current)}`, {
        timeoutMs: 5000,
      });
      const next = String(nested?.now || '').trim();
      if (!next || next === current) break;
      current = next;
    } catch (_) {
      current = '';
      break;
    }
  }
  return configNameSet.has(current) ? current : '';
}

async function fetchClashMiniProxyNames(coreDir, groupName) {
  const response = await fetchClashMiniGroup(coreDir, groupName);
  const configNames = getClashMiniConfigProxyNames(coreDir);
  const configNameSet = new Set(configNames);
  const responseNames = response && (response.all || response.proxies || response);
  const apiNames = normalizeProxyNameList(responseNames).filter((name) => configNameSet.has(name));
  const currentName = String((response && (response.now || response.name)) || '').trim();
  return {
    raw: response,
    names: Array.from(new Set([...apiNames, ...configNames])),
    current: await resolveClashMiniCurrentProxy(coreDir, currentName, configNameSet),
  };
}

async function probeClashMiniProxyDelay(coreDir, proxyName, testUrl, timeout) {
  const response = await invokeClashMiniControl(coreDir, 'get', `/proxies/${encodeURIComponent(proxyName)}/delay?timeout=${encodeURIComponent(timeout)}&url=${encodeURIComponent(testUrl)}`, {
    timeoutMs: Math.max(Number(timeout) || 5000, 8000),
  });
  return {
    raw: response,
    delay: extractDelayValue(response),
  };
}

// 批量测速：一次 GET /group/{组名}/delay 让内核并发测完整组节点，
// 总耗时约等于单节点超时上限，远快于外部逐节点循环。
// 返回 { 节点名: 延迟ms } 映射（失败节点会被内核省略）。
// 老内核不支持该端点时抛错（404），由调用方回退逐节点方案。
async function probeClashMiniGroupDelay(coreDir, groupName, testUrl, timeout) {
  const probeTimeout = Math.max(Number(timeout) || 5000, 1000);
  const response = await invokeClashMiniControl(
    coreDir,
    'get',
    `/group/${encodeURIComponent(groupName)}/delay?timeout=${encodeURIComponent(probeTimeout)}&url=${encodeURIComponent(testUrl)}`,
    // 内核要等最慢节点超时后才返回，HTTP 侧留足余量。
    { timeoutMs: probeTimeout + 10000 },
  );
  return response && typeof response === 'object' && !Array.isArray(response) ? response : {};
}

function formatClashMiniDelayText(delay) {
  const value = Number(delay);
  if (!Number.isFinite(value) || value <= 0) return '超时';
  return `${Math.round(value)}ms`;
}

async function collectClashMiniProxyDelays(coreDir, names, latencyUrl, timeout, concurrency = 8) {
  const uniqueNames = Array.from(new Set((Array.isArray(names) ? names : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)));
  if (uniqueNames.length === 0) {
    return [];
  }

  const poolSize = Math.max(
    1,
    Math.min(uniqueNames.length, Number.isFinite(Number(concurrency)) && Number(concurrency) > 0 ? Math.floor(Number(concurrency)) : 8),
  );

  const entries = new Array(uniqueNames.length);
  let cursor = 0;
  const workers = Array.from({ length: poolSize }, async () => {
    while (cursor < uniqueNames.length) {
      const currentIndex = cursor++;
      const name = uniqueNames[currentIndex];
      try {
        const probe = await probeClashMiniProxyDelay(coreDir, name, latencyUrl, timeout);
        const delay = Number(probe.delay);
        entries[currentIndex] = {
          name,
          delay: Number.isFinite(delay) ? delay : null,
          delayText: formatClashMiniDelayText(delay),
          ok: Number.isFinite(delay) && delay > 0,
        };
      } catch (error) {
        entries[currentIndex] = {
          name,
          delay: null,
          delayText: '超时',
          ok: false,
          error: error?.message || String(error),
        };
      }
    }
  });

  await Promise.all(workers);
  return entries.filter(Boolean);
}

async function waitForClashMiniControlApi(coreDir, timeoutMs = 15000, shouldCancel = null) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 15000);
  const probePaths = ['/version', '/proxies', '/configs'];
  const headers = buildClashMiniControlHeaders(coreDir);

  while (Date.now() < deadline) {
    if (typeof shouldCancel === 'function' && shouldCancel()) return false;
    const probeTimeout = Math.max(100, Math.min(750, deadline - Date.now()));
    const responses = await Promise.all(probePaths.map((probePath) => (
      axios.get(buildClashMiniControlUrl(coreDir, probePath), {
        timeout: probeTimeout,
        headers,
        validateStatus: () => true,
      }).catch(() => null)
    )));
    if (responses.some((response) => response && typeof response.status === 'number' && response.status < 500)) {
      return true;
    }

    if (typeof shouldCancel === 'function' && shouldCancel()) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return false;
}

async function invokeClashMiniControl(coreDir, method, pathname, { data = null, timeoutMs = 30000 } = {}) {
  const url = buildClashMiniControlUrl(coreDir, pathname);
  const headers = buildClashMiniControlHeaders(coreDir);
  const response = await axios({
    method,
    url,
    data,
    timeout: timeoutMs,
    headers,
    validateStatus: () => true,
  });
  if (response.status < 200 || response.status >= 300) {
    const payload = response.data && typeof response.data === 'object' ? response.data : {};
    const message = payload.error || payload.message || `控制接口请求失败 (${response.status})`;
    throw new Error(String(message));
  }
  return response.data;
}

// Mihomo 的运行模式可以通过控制接口被其他客户端临时切换。每次接管核心时
// 都重新确认 rule，避免磁盘配置正确但当前进程仍停留在 global/direct。
async function ensureClashMiniRuleMode(coreDir) {
  try {
    const current = await invokeClashMiniControl(coreDir, 'get', '/configs', { timeoutMs: 5000 });
    const currentMode = String(current?.mode || '').trim().toLowerCase();
    if (currentMode === CLASH_MINI_RULE_MODE) {
      return { ok: true, changed: false, mode: CLASH_MINI_RULE_MODE };
    }
    await invokeClashMiniControl(coreDir, 'patch', '/configs', {
      data: { mode: CLASH_MINI_RULE_MODE },
      timeoutMs: 5000,
    });
    return { ok: true, changed: true, mode: CLASH_MINI_RULE_MODE, previousMode: currentMode };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

module.exports = {
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
};
