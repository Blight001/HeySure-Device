const { isServerBaseAllowedForMode } = require('../utils/server-mode');

function normalizeTimeoutMs(value, fallbackMs = 8000) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallbackMs;
  if (num < 1000) return Math.round(num * 1000);
  return Math.round(num);
}

function collectUrlCandidates(normalizeUrl, ...groups) {
  const seen = new Set();
  const result = [];
  for (const group of groups) {
    const values = Array.isArray(group) ? group : [group];
    for (const value of values) {
      const normalized = normalizeUrl(value);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function resolveServerBaseFromAddress(address) {
  const raw = String(address || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    const pathname = String(url.pathname || '').replace(/\/+$/, '');
    return `${url.protocol}//${url.host}${pathname === '/' ? '' : pathname}`.replace(/\/+$/, '');
  } catch (_) {
    return raw.replace(/\/+$/, '');
  }
}

function isLoopbackHost(host) {
  const value = String(host || '').toLowerCase();
  return value === 'localhost' || value === '::1' || /^127(?:\.|$)/.test(value);
}

function publishLoopbackAddress(address, serviceUrl) {
  const raw = String(address || '').trim();
  const serviceRaw = String(serviceUrl || '').trim();
  if (!raw || !serviceRaw) return raw;
  try {
    const target = new URL(raw.includes('://') ? raw : `http://${raw}`);
    const service = new URL(serviceRaw.includes('://') ? serviceRaw : `http://${serviceRaw}`);
    if (!isLoopbackHost(target.hostname) || !service.hostname || isLoopbackHost(service.hostname)) return raw;
    target.hostname = service.hostname;
    return target.toString().replace(/\/+$/, '');
  } catch (_) {
    return raw;
  }
}

function resolveTcpAddressMeta(address) {
  const raw = String(address || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes('://') ? raw : `tcp://${raw}`);
    const host = String(url.hostname || '').trim();
    const port = Number(url.port);
    return host && Number.isFinite(port) && port > 0 ? { host, port: Math.round(port) } : null;
  } catch (_) {
    const stripped = raw.replace(/^tcp:\/\//i, '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const [host, portText] = stripped.split(':');
    const port = Number(portText);
    return host && Number.isFinite(port) && port > 0 ? { host: host.trim(), port: Math.round(port) } : null;
  }
}

function normalizeAccountServiceUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    const pathname = String(url.pathname || '').replace(/\/+$/, '');
    const accountApiIndex = pathname.indexOf('/api/account');
    url.pathname = accountApiIndex >= 0
      ? `${pathname.slice(0, accountApiIndex)}/api/account`
      : `${pathname === '/' ? '' : pathname}/api/account`;
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch (_) {
    return `${value.replace(/\/+$/, '')}/api/account`;
  }
}

function createPlatformsConfigTools(deps) {
  function readPlatformsConfigSafe() {
    try {
      const candidates = [
        deps.path.join(__dirname, '../../../../platforms-config.json'),
        deps.path.join(__dirname, '../../../../docs/config/platforms-config.json'),
        deps.path.join(__dirname, '../../../../config/platforms-config.json'),
      ];
      for (const configPath of candidates) {
        if (!deps.fs.existsSync(configPath)) continue;
        return JSON.parse(deps.fs.readFileSync(configPath, 'utf8'));
      }
    } catch (error) {
      deps.logger.warn?.('[配置] 读取平台配置失败:', error?.message || error);
    }
    return {};
  }

  function detectPlatformKeyFromRuntime() {
    const defaultPlatform = String(readPlatformsConfigSafe()?.defaultPlatform || '').trim();
    if (defaultPlatform) return defaultPlatform;
    return String(process.env.PLATFORM || '').trim() || 'default';
  }

  function getPlatformDefaultConfig(platformKey) {
    const cfg = readPlatformsConfigSafe();
    const platformConfigs = cfg.platformConfigs || {};
    if (platformConfigs[platformKey]) return platformConfigs[platformKey];
    const defaultPlatform = String(cfg.defaultPlatform || '').trim();
    if (defaultPlatform && platformConfigs[defaultPlatform]) return platformConfigs[defaultPlatform];
    const firstKey = Object.keys(platformConfigs)[0];
    return firstKey ? platformConfigs[firstKey] || {} : {};
  }

  return { readPlatformsConfigSafe, detectPlatformKeyFromRuntime, getPlatformDefaultConfig };
}

function resolveAccountServiceSources(cfg, platformKey) {
  const platform = (cfg.platformConfigs || {})[platformKey] || {};
  const rootService = cfg.accountService && typeof cfg.accountService === 'object' ? cfg.accountService : {};
  const platformService = platform.accountService && typeof platform.accountService === 'object'
    ? platform.accountService
    : {};
  return { platform, rootService, platformService };
}

function accountServiceTimeout(sources) {
  return sources.platformService.timeoutSec
    || sources.rootService.timeoutSec
    || sources.platformService.timeoutMs
    || sources.rootService.timeoutMs
    || 8;
}

function collectAccountServiceUrls(sources, cfg, getServerBase) {
  return collectUrlCandidates(
    normalizeAccountServiceUrl,
    process.env.ACCOUNT_SERVICE_URL,
    process.env.SERVER_BASE,
    sources.platformService.url,
    sources.platformService.urls,
    sources.rootService.url,
    sources.rootService.urls,
    sources.platform.accountServiceUrl,
    sources.platform.accountServiceUrls,
    cfg.accountServiceUrl,
    cfg.accountServiceUrls,
    getServerBase(),
  ).filter((candidate) => isServerBaseAllowedForMode(candidate));
}

function createAccountServiceConfigResolver(deps, platformTools) {
  return function resolveAccountServiceConfig() {
    try {
      const cfg = platformTools.readPlatformsConfigSafe();
      const sources = resolveAccountServiceSources(cfg, platformTools.detectPlatformKeyFromRuntime());
      const urls = collectAccountServiceUrls(sources, cfg, deps.getServerBase);
      return { url: urls[0] || '', urls, timeoutMs: normalizeTimeoutMs(accountServiceTimeout(sources), 8000) };
    } catch (error) {
      deps.logger.warn?.('[配置] 读取单平台账号服务配置失败:', error?.message || error);
      return { url: '', urls: [], timeoutMs: 8000 };
    }
  };
}

const PUBLISHED_ADDRESS_FIELDS = [
  'serverBase', 'server_base', 'address_HTTP', 'addressHttp', 'address_http',
  'address', 'client_address', 'clientAddress',
];

function publishResponseAddresses(source, serviceUrl) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return source;
  const published = { ...source };
  for (const field of PUBLISHED_ADDRESS_FIELDS) {
    if (typeof published[field] === 'string' && published[field].trim()) {
      published[field] = publishLoopbackAddress(published[field], serviceUrl);
    }
  }
  return published;
}

function firstPublishedAddress(source) {
  if (!source || typeof source !== 'object') return '';
  for (const field of PUBLISHED_ADDRESS_FIELDS) {
    const value = String(source[field] || '').trim();
    if (value) return value;
  }
  return '';
}

function publishSuccessfulAccountResponse(body, endpoint) {
  const published = publishResponseAddresses(body, endpoint.toString());
  for (const field of ['validation', 'result', 'data']) {
    if (published[field] && typeof published[field] === 'object') {
      published[field] = publishResponseAddresses(published[field], endpoint.toString());
    }
  }
  const nestedBase = firstPublishedAddress(published)
    || firstPublishedAddress(published.validation)
    || firstPublishedAddress(published.result)
    || firstPublishedAddress(published.data);
  const servicePath = endpoint.pathname.replace(/\/api\/account\/[^/]+\/?$/, '');
  const serverBase = nestedBase || `${endpoint.protocol}//${endpoint.host}${servicePath}`.replace(/\/+$/, '');
  published.serverBase = serverBase;
  published.server_base = serverBase;
  return published;
}

function buildAccountEndpoint(rawUrl, action) {
  const endpoint = new URL(rawUrl);
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/${String(action || '').replace(/^\/+/, '')}`;
  endpoint.search = '';
  return endpoint;
}

async function requestAccountEndpoint(deps, rawUrl, action, payload, timeoutMs) {
  const endpoint = buildAccountEndpoint(rawUrl, action);
  const response = await deps.postJson(endpoint.toString(), payload, timeoutMs);
  const body = response?.body && typeof response.body === 'object' ? response.body : {};
  if (body.ok === true) return { done: true, value: publishSuccessfulAccountResponse(body, endpoint) };
  const message = body.message || body.error || response?.raw || '';
  if (response?.status && response.status < 500) {
    return { done: true, value: { ...body, ok: false, message: message || '账号操作失败' }, message };
  }
  return { done: false, message };
}

function createAccountAuthenticator(deps, resolveServiceConfig) {
  async function requestAccountService(action, payload = {}) {
    try {
      const service = resolveServiceConfig();
      const urls = service.urls.length ? service.urls : service.url ? [service.url] : [];
      if (!urls.length) return { ok: false, message: '未配置账号服务地址' };
      let lastMessage = '';
      for (const rawUrl of urls) {
        try {
          const outcome = await requestAccountEndpoint(deps, rawUrl, action, payload, service.timeoutMs);
          if (outcome.done) return outcome.value;
          lastMessage = outcome.message || lastMessage;
        } catch (error) {
          lastMessage = error?.message || String(error);
        }
      }
      return { ok: false, message: lastMessage || '账号服务暂时不可用' };
    } catch (error) {
      return { ok: false, message: error?.message || String(error) };
    }
  }

  return async function authenticateAccount(payload = {}) {
    const mode = String(payload.mode || '').trim().toLowerCase();
    const action = mode === 'register' ? 'register' : mode === 'device' ? 'device-login' : 'login';
    return requestAccountService(action, payload);
  };
}

function resolvedHttpBase(resolved) {
  return String(
    resolved.serverBase || resolved.address_HTTP || resolved.addressHttp || resolved.address_http
    || resolved.client_address || resolved.clientAddress || resolved.address || '',
  ).trim();
}

function applyLicenseRuntimeConfig(licenseCache, resolved, serverBase) {
  if (!licenseCache || typeof licenseCache.setRuntimeConfig !== 'function') return;
  const config = { serverBase };
  if (resolved.platformName) config.platformName = resolved.platformName;
  if (Array.isArray(resolved.allowedPlatforms) && resolved.allowedPlatforms.length) {
    config.allowedPlatforms = resolved.allowedPlatforms;
  }
  const woolPlatforms = resolved.woolPlatforms ?? resolved.wool_platforms;
  if (Array.isArray(woolPlatforms)) config.woolPlatforms = woolPlatforms;
  if (String(resolved.targetUrl || '').trim()) config.targetUrl = String(resolved.targetUrl).trim();
  if (String(resolved.tutorialUrl || '').trim()) config.tutorialUrl = String(resolved.tutorialUrl).trim();
  licenseCache.setRuntimeConfig(config);
}

function applyRuntimeServerEndpoints(deps, resolved, serverBase) {
  const tcp = resolved.tcp && typeof resolved.tcp === 'object'
    ? resolved.tcp
    : resolveTcpAddressMeta(resolved.address_TCP || resolved.addressTcp || resolved.address_tcp || '');
  deps.setRuntimeTcpConfig(tcp ? {
    host: tcp.host || '', port: tcp.port || 0, transport: tcp.transport || {},
  } : null);
  deps.setRuntimeServerBase(serverBase);
}

function createResolvedConfigApplier(deps) {
  return function applyResolvedConfigToStore({ resolved }) {
    const serverBase = resolvedHttpBase(resolved);
    applyLicenseRuntimeConfig(deps.licenseCache, resolved, serverBase);
    try {
      applyRuntimeServerEndpoints(deps, resolved, serverBase);
    } catch (error) {
      deps.logger.warn?.('[配置] 写入运行时服务器配置失败:', error?.message || error);
    }
    return {};
  };
}

function createServerResolver(input = {}) {
  const deps = {
    setRuntimeTcpConfig: () => {},
    setRuntimeServerBase: () => {},
    logger: console,
    ...input,
  };
  const platformTools = createPlatformsConfigTools(deps);
  const resolveAccountServiceConfig = createAccountServiceConfigResolver(deps, platformTools);
  return {
    ...platformTools,
    resolveServerBaseFromAddress,
    publishLoopbackAddress,
    normalizeAccountServiceUrl,
    resolveAccountServiceConfig,
    authenticateAccount: createAccountAuthenticator(deps, resolveAccountServiceConfig),
    applyResolvedConfigToStore: createResolvedConfigApplier(deps),
  };
}

module.exports = { createServerResolver };
