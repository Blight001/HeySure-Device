const path = require('path');
const { app } = require('electron');
const fs = require('fs');
const { isServerBaseAllowedForMode } = require('../utils/server-mode');

// 集中配置与常量（可通过环境变量覆盖）

// 命名遗留说明：下方 "TCP" 命名（RUNTIME_TCP_CONFIG / getTcpConfig / setRuntimeTcpConfig /
// normalizeTcpPort / DEFAULT_TCP_TRANSPORT）为历史遗留——原 TCP 长连接通道已整体迁移为纯 HTTP。
// 这些结构现在仅承载服务器响应下发的 address_TCP（host:port）元数据（见 services/server-resolver.js
// 与 ipc/register/license.js），供 getServerBase() 在无显式 HTTP 地址时兜底反推 HTTP 地址；
// DISABLE_TCP_CONNECTION / NO_TCP 环境变量是 FORCE_HTTP_COMPAT_MODE 的兼容别名，保留不删。
// 统一改名（如 getTcpConfig → getServerEndpoint）涉及多处调用方签名，留待后续重构。

// 开发环境默认配置
let DREAM_TARGET_URL = 'https://dreamina.capcut.com/ai-tool/home?';
let RUNTIME_TCP_CONFIG = null;
let RUNTIME_SERVER_BASE = '';

function isHttpCompatModeEnabled() {
  const flag = String(
    process.env.FORCE_HTTP_COMPAT_MODE
    || process.env.NETWORK_COMPAT_MODE
    || process.env.DISABLE_TCP_CONNECTION
    || process.env.NO_TCP
    || ''
  ).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on', 'http', 'http-only', 'compat', 'compat-mode'].includes(flag);
}

const DEFAULT_TCP_TRANSPORT = {
  preferred: 'tls',
  allowHttpFallback: true,
  allowPlainFallback: false,
  tls: {
    enabled: true,
    rejectUnauthorized: false,
  },
};

// 规范化 TCP 端口，非法值回退到默认端口。
function normalizeTcpPort(port, fallback = 58113) {
  const resolved = Number(port);
  if (!Number.isFinite(resolved) || resolved <= 0) {
    return fallback;
  }
  return Math.round(resolved);
}

// 读取平台配置文件。
function readPlatformsConfigSafe() {
  try {
    const candidates = [
      path.join(app?.getAppPath ? app.getAppPath() : '', 'platforms-config.json'),
      path.join(process.cwd(), 'platforms-config.json'),
      path.join(__dirname, '../../../../platforms-config.json'),
      path.join(app?.getAppPath ? app.getAppPath() : '', 'docs', 'config', 'platforms-config.json'),
      path.join(process.cwd(), 'docs', 'config', 'platforms-config.json'),
      path.join(__dirname, '../../../../docs/config/platforms-config.json'),
      path.join(app?.getAppPath ? app.getAppPath() : '', 'config', 'platforms-config.json'),
      path.join(process.cwd(), 'config', 'platforms-config.json'),
      path.join(__dirname, '../../../../config/platforms-config.json'),
    ].filter(Boolean);

    for (const configPath of candidates) {
      if (!fs.existsSync(configPath)) continue;
      const raw = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(raw || '{}');
    }
  } catch (_) {}
  return {};
}

// 清理 store 中旧版卡密缓存；账号登录会话需要保留，以便下次启动恢复。
/** @param {Record<string, any>} [storeConfig] */
function pruneStoreLicenseFields(storeConfig = {}) {
  const next = { ...(storeConfig || {}) };
  let changed = false;

  if (next.userCredentials && typeof next.userCredentials === 'object') {
    const { serializeAccountSession } = require('../utils/account-session');
    const normalizedCredentials = serializeAccountSession(next.userCredentials);
    if (JSON.stringify(next.userCredentials) !== JSON.stringify(normalizedCredentials)) {
      next.userCredentials = normalizedCredentials;
      changed = true;
    }
  }

  for (const field of [
    'tcp',
    'targetUrl',
    'tutorialUrl',
    'allowedPlatforms',
    'serverBase',
    'platformName',
    'licenseUsage',
    'licenseRegionInfo',
    'lastValidatedAt',
    'licenseValidated',
    'cardStatus',
    'cardExpiryDate',
    'systemProxyMode',
    'systemProxyEnabled',
    'validationSuccessCount',
    'magicStateRestoreReady',
    'removeWatermarkEnabled',
    'translateExtEnabled',
  ]) {
    if (Object.prototype.hasOwnProperty.call(next, field)) {
      delete next[field];
      changed = true;
    }
  }

  return { next, changed };
}

function ensureDirectory(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }
}

function replaceLegacyStoreFile(storeDir) {
  if (!fs.existsSync(storeDir)) return;
  try {
    if (!fs.statSync(storeDir).isFile()) return;
    fs.unlinkSync(storeDir);
    console.log('[配置] 已清理旧的 store 文件');
  } catch (error) {
    console.warn('[配置] 检查 store 目录失败:', error?.message || error);
  }
}

function prunePersistedStore(storePath) {
  try {
    if (!fs.existsSync(storePath)) return;
    const parsedStore = JSON.parse(fs.readFileSync(storePath, 'utf8') || '{}');
    const pruned = pruneStoreLicenseFields(parsedStore);
    if (!pruned.changed) return;
    fs.writeFileSync(storePath, JSON.stringify(pruned.next, null, 2), { encoding: 'utf8' });
    console.log('[配置] 已清理 store/content 中的旧版卡密元数据，并保留有效账号会话');
  } catch (error) {
    console.warn('[配置] 清理 store/content 卡密元数据失败:', error?.message || error);
  }
}

/**
 * 初始化核心目录：打包后将resources/core复制到用户数据目录
 */
// 初始化用户数据目录下的 core/store 结构，并清理旧版遗留数据。
function initializeCoreDirectory() {
  try {
    // 新策略：不再从 resources 复制整个 core 目录到用户数据目录。
    // 仅确保用户数据目录下的 core 结构存在，若缺失则创建最小需要的目录与默认 store。
    const userDataCoreDir = path.join(app.getPath('userData'), 'core');
    const storeDir = getStoreDir();

    // 确保 core 根目录存在
    ensureDirectory(userDataCoreDir);
    replaceLegacyStoreFile(storeDir);
    ensureDirectory(storeDir);

    const storePath = getStorePath();
    prunePersistedStore(storePath);

    // 如果 store 不存在，则创建一个最小默认配置（避免覆盖已有用户配置）
    // 使用统一的 getStorePath()（位于用户数据根目录的 store/content），避免与其他模块期望位置不一致
    if (!fs.existsSync(storePath)) {
      // 先使用内置的默认值（若被意外替换破坏，请恢复此结构）
      // 默认值会在卡密验证成功后被覆盖为接口返回服务器配置
      const defaultStore = {};

        fs.writeFileSync(storePath, JSON.stringify(defaultStore, null, 2), { encoding: 'utf8' });
        console.log('[配置] 已创建默认 store/content:', storePath);
    }
    return true;
  } catch (error) {
    console.error('[配置] 初始化核心目录失败:', error);
    return false;
  }
}

function normalizeTcpTransport(transport = {}, httpCompatMode = false) {
  const tls = transport.tls || {};
  return {
    preferred: httpCompatMode ? 'http' : String(transport.preferred || 'tls').toLowerCase(),
    allowHttpFallback: transport.allowHttpFallback !== false,
    allowPlainFallback: false,
    tls: {
      enabled: true,
      rejectUnauthorized: tls.rejectUnauthorized === true,
      caPath: String(tls.caPath || tls.ca_path || '').trim(),
      certFingerprint: String(tls.certFingerprint || tls.cert_fingerprint || '').trim(),
    },
  };
}

function createTcpConfig(config, transport, httpCompatMode) {
  return {
    host: config.host || '127.0.0.1',
    port: normalizeTcpPort(config.port),
    transport: normalizeTcpTransport(transport, httpCompatMode),
  };
}

// TCP 服务器配置（从 store 获取）
// 读取当前 store 配置，失败时返回空对象。
function getStoreConfig() {
  try {
    const storePath = getStorePath();
    if (!fs.existsSync(storePath)) {
      console.warn('[配置] store不存在，使用默认配置');
      return {};
    }
    const storeData = fs.readFileSync(storePath, 'utf8');
    return JSON.parse(storeData);
  } catch (error) {
    console.warn('[配置] 无法读取 store，使用默认配置:', error.message);
    return {};
  }
}

// 动态获取 TCP 配置（每次调用都会重新读取 store，保证在 initializeCoreDirectory 创建默认 store 后能及时生效）
// 生成当前可用的 TCP 配置，优先使用运行时覆盖值。
function getTcpConfig() {
  try {
    const httpCompatMode = isHttpCompatModeEnabled();
    if (RUNTIME_TCP_CONFIG && typeof RUNTIME_TCP_CONFIG === 'object') {
      return createTcpConfig(
        RUNTIME_TCP_CONFIG,
        RUNTIME_TCP_CONFIG.transport || {},
        httpCompatMode,
      );
    }

    const cfg = getStoreConfig();
    const tcpCfg = cfg.tcp || {};
    const transportCfg = tcpCfg.transport || cfg.transport || cfg.connectionTransport || {};
    return createTcpConfig(tcpCfg, transportCfg, httpCompatMode);
  } catch (_) {
    return {
      host: '127.0.0.1',
      port: normalizeTcpPort(null),
      transport: { ...DEFAULT_TCP_TRANSPORT }
    };
  }
}

function normalizeServerBase(value) {
  const normalized = String(value || '').trim().replace(/\/+$/, '');
  return isServerBaseAllowedForMode(normalized) ? normalized : '';
}

function getConfiguredAccountServiceUrl(platformConfig, platformsConfig) {
  const accountService = platformConfig.accountService || platformsConfig.accountService || {};
  const firstServiceUrl = Array.isArray(accountService.urls) ? accountService.urls[0] : '';
  return String(
    accountService.url
    || firstServiceUrl
    || platformConfig.accountServiceUrl
    || platformsConfig.accountServiceUrl
    || ''
  ).trim();
}

function getAccountServiceBase() {
  const platformsConfig = readPlatformsConfigSafe();
  const platformKey = String(process.env.PLATFORM || platformsConfig.defaultPlatform || 'default').trim();
  const platformConfig = (platformsConfig.platformConfigs || {})[platformKey] || {};
  const accountServiceUrl = getConfiguredAccountServiceUrl(platformConfig, platformsConfig);
  if (!accountServiceUrl) return '';
  try {
    const parsed = new URL(accountServiceUrl);
    const accountPathIndex = parsed.pathname.indexOf('/api/account');
    parsed.pathname = accountPathIndex >= 0 ? parsed.pathname.slice(0, accountPathIndex) || '/' : '/';
    parsed.search = '';
    parsed.hash = '';
    return normalizeServerBase(parsed.toString());
  } catch (_) {
    return '';
  }
}

function getDirectStoreBase(config) {
  return normalizeServerBase(
    config.serverBase
    || config.server_base
    || config.httpBase
    || config.http_base
    || config.apiBase
    || config.api_base,
  );
}

function getStructuredStoreBase(config) {
  const http = config.http || config.httpServer || config.server || config.api;
  if (!http || typeof http !== 'object') return '';
  const protocol = http.protocol || (http.https ? 'https' : 'http');
  const host = http.host || http.hostname;
  if (!host) return '';
  const port = http.port || http.httpPort || http.http_port;
  return normalizeServerBase(`${protocol}://${host}${port ? `:${port}` : ''}`);
}

function getTcpFallbackBase(config) {
  const tcp = getTcpConfig();
  if (!tcp?.host) return '';
  const configuredPort = Number(config.httpPort || config.http_port);
  const tcpPort = Number(tcp.port);
  const port = configuredPort || (Number.isFinite(tcpPort) ? tcpPort : 0);
  return normalizeServerBase(`http://${tcp.host}${port ? `:${port}` : ''}`);
}

// 动态获取 HTTP 服务器 base（支持环境变量与 store）
// 解析当前 HTTP 服务基址，按环境变量、运行时值、store 逐层兜底。
function getServerBase() {
  try {
    const httpCompatMode = isHttpCompatModeEnabled();
    const runtimeBase = normalizeServerBase(RUNTIME_SERVER_BASE);
    if (httpCompatMode && runtimeBase) return runtimeBase;
    const envBase = normalizeServerBase(process.env.SERVER_BASE);
    if (envBase) return envBase;
    if (runtimeBase) return runtimeBase;

    // 模型列表允许匿名读取。尚未登录时，从账号服务入口推导客户端 HTTP 根地址，
    // 例如 http://host:58111/api/account -> http://host:58111。
    const accountServiceBase = getAccountServiceBase();
    if (accountServiceBase) return accountServiceBase;

    const cfg = getStoreConfig() || {};
    const storeBase = getDirectStoreBase(cfg) || getStructuredStoreBase(cfg);
    if (storeBase) return storeBase;

    // 最后兜底：由 TCP 配置直接推导 HTTP 地址，保持返回端口原样
    return getTcpFallbackBase(cfg);
  } catch (_) {}
  return '';
}

// 网络诊断配置
const NETWORK_DIAG_CONFIG = {
  CONNECTION_TIMEOUT: 30000, // 连接超时时间 (30秒)
  REQUEST_TIMEOUT: 5000,     // 请求超时时间 (5秒)
  RETRY_ATTEMPTS: 3,         // 重试次数
  RETRY_DELAY: 2000,         // 重试间隔 (2秒)
};

// ---- 动态URL设置 ----

// 设置动态获取的目标URL
// 更新即梦页面的目标地址，只接受合法 http(s) URL。
function setDreamTargetUrl(url) {
  if (url && typeof url === 'string' && url.startsWith('http')) {
    DREAM_TARGET_URL = url;
    console.log('[配置] DREAM_TARGET_URL 已更新为:', url);
  } else {
    console.warn('[配置] 无效的URL，保持原有值:', url);
  }
}

// 获取当前即梦页面目标地址。
function getDreamTargetUrl() {
  return DREAM_TARGET_URL;
}

// 设置运行时 TCP 配置，供登录后或动态下发场景覆盖 store。
function setRuntimeTcpConfig(tcpConfig = null) {
  if (!tcpConfig || typeof tcpConfig !== 'object') {
    RUNTIME_TCP_CONFIG = null;
    return null;
  }

  const host = String(tcpConfig.host || '').trim();
  const port = Number(tcpConfig.port);
  if (!host || !Number.isFinite(port) || port <= 0) {
    RUNTIME_TCP_CONFIG = null;
    return null;
  }

  RUNTIME_TCP_CONFIG = {
    host,
    port: normalizeTcpPort(port),
    transport: normalizeTcpTransport(tcpConfig.transport || {}),
  };
  return { ...RUNTIME_TCP_CONFIG };
}

// 设置运行时 HTTP 基址覆盖值。
function setRuntimeServerBase(serverBase = '') {
  const candidate = String(serverBase || '').trim().replace(/\/+$/, '');
  RUNTIME_SERVER_BASE = isServerBaseAllowedForMode(candidate) ? candidate : '';
  return RUNTIME_SERVER_BASE;
}

// ---- 路径配置 ----

// 获取核心目录路径（支持打包后环境）
// 查找 clash-mini core 的实际安装目录，兼容打包和开发环境。
function getCoreDir() {
  try {
    const candidates = [];

    if (app && app.isPackaged) {
      const installDir = path.dirname(app.getPath('exe'));
      candidates.push(path.join(process.resourcesPath || '', 'clash-mini', 'core'));
      candidates.push(path.join(installDir, 'resources', 'clash-mini', 'core'));
    } else {
      candidates.push(path.join(__dirname, '../../../../resources/clash-mini/core'));
      candidates.push(path.join(process.cwd(), 'resources', 'clash-mini', 'core'));
      let currentDir = __dirname;
      while (currentDir !== path.parse(currentDir).root) {
        candidates.push(path.join(currentDir, 'core'));
        currentDir = path.dirname(currentDir);
      }
      candidates.push(path.join(__dirname, '../../../../core'));
      candidates.push(path.join(process.cwd(), 'core'));
    }

    for (const candidate of candidates) {
      if (!candidate) continue;
      const hasCoreFiles =
        fs.existsSync(path.join(candidate, 'verge-mihomo.exe')) ||
        fs.existsSync(path.join(candidate, 'config.yaml')) ||
        fs.existsSync(path.join(candidate, 'self.yaml'));
      if (hasCoreFiles) {
        return candidate;
      }
    }

    return candidates[0] || path.join(__dirname, '../../../../resources/clash-mini/core');
  } catch (_) {
    return path.join(__dirname, '../../../../resources/clash-mini/core');
  }
}

// 获取 store 的稳定位置（始终放在用户数据根目录下的 store/content，避免放在 core 子目录）
// 获取 store 目录的稳定路径，始终优先放在用户数据目录。
function getStoreDir() {
  try {
    if (app && app.getPath) {
      return path.join(app.getPath('userData'), 'store');
    }
    return path.join(__dirname, '../../../../core', 'store');
  } catch (_) {
    return path.join(__dirname, '../../../../core', 'store');
  }
}

// 获取 store/content 文件路径。
function getStorePath() {
  try {
    return path.join(getStoreDir(), 'content');
  } catch (_) {
    return path.join(__dirname, '../../../../core', 'store', 'content');
  }
}

module.exports = {
  DREAM_TARGET_URL,
  setDreamTargetUrl,
  getDreamTargetUrl,
  setRuntimeTcpConfig,
  setRuntimeServerBase,
  NETWORK_DIAG_CONFIG,
  // 路径相关
  getCoreDir,
  getStorePath,
  // 核心文件管理
  initializeCoreDirectory,
  getTcpConfig,
  getServerBase,
};


