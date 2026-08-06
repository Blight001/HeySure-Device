const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const {
  CLASH_MINI_DIR_NAME,
  copyDirectoryRecursive,
  extractDirectClashConfigContent,
  getClashMiniRuntimeRoot,
  getClashMiniStatus,
  importDirectClashRuntimeConfig,
  prepareClashMiniRuntimeDirAsync,
  resolveClashMiniCoreDir,
  setRuntimeLicenseCache,
  startClashMiniProcess,
  stopClashMiniProcess,
  invokeClashMiniControl,
} = require('../../ipc/register/clash-mini-core');
const {
  getClashMiniProxyGroupOptions,
  switchClashMiniProxyNode,
  testClashMiniLowestLatency,
} = require('../../ipc/register/clash-mini-actions');
const { createProxyTrafficMonitor } = require('../../ipc/register/proxy-traffic-monitor');
const { httpGetUniversal } = require('../../lib/http');
const { getServerBase } = require('../../config');

function clashError(error) {
  return error?.message || String(error);
}

function normalizeYamlContent(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.replace(/^\uFEFF/, '').trim();
  if (typeof value !== 'object') return '';
  try {
    return YAML.stringify(value).replace(/^\uFEFF/, '').trim();
  } catch (_) {
    return '';
  }
}

function resolveClashConfigContent(result) {
  const profilesYamlContent = normalizeYamlContent(result?.profiles_yaml_content);
  const yamlContent = normalizeYamlContent(result?.yaml_content)
    || normalizeYamlContent(result?.content)
    || normalizeYamlContent(result?.configContent);
  const redYamlContent = normalizeYamlContent(result?.red_yaml_content);
  const content = profilesYamlContent || yamlContent || redYamlContent || extractDirectClashConfigContent(result);
  let source = 'empty';
  if (profilesYamlContent) source = 'profiles-yaml';
  else if (yamlContent) source = 'yaml-content';
  else if (redYamlContent) source = 'red-yaml';
  else if (content) source = 'extracted';
  return { profilesYamlContent, redYamlContent, content, source };
}

function serializeClashConfig(result) {
  const resolved = resolveClashConfigContent(result);
  return {
    ok: Boolean(result?.ok),
    content: resolved.content,
    contentSource: resolved.source,
    contentLength: String(resolved.content || '').length,
    proxySubscriptionUrl: result?.proxy_subscription_url || '',
    profilesYamlContent: resolved.profilesYamlContent,
    redYamlContent: resolved.redYamlContent,
    accountType: readClashResultField(result, 'account_type', 'accountType'),
    accountTypeLabel: readClashResultField(result, 'account_type_label', 'accountTypeLabel'),
    expire_at: result?.expire_at || '',
    days_left: result?.days_left,
  };
}

function readClashResultField(result, snakeField, camelField) {
  return result?.[snakeField] || result?.[camelField] || '';
}

function resolveSubscriptionUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return raw;
  const base = String(getServerBase() || '').trim();
  if (!base) return raw;
  try {
    return new URL(raw, base.endsWith('/') ? base : `${base}/`).toString();
  } catch (_) {
    return raw;
  }
}

async function fetchSubscriptionContent(url) {
  const targetUrl = resolveSubscriptionUrl(url);
  if (!targetUrl) return '';
  console.log('[IPC] 直接配置导入失败，开始尝试订阅链接:', targetUrl);
  const response = await httpGetUniversal(targetUrl, 15000);
  if (!response || response.ok !== true) throw new Error(`订阅链接请求失败: ${response?.status || 'unknown'}`);
  return String(
    extractDirectClashConfigContent(response.body)
    || extractDirectClashConfigContent(response.raw)
    || response.raw
    || '',
  ).trim();
}

function getClashSourcePayload(payload) {
  return payload.clashConfig
    || payload.configContent
    || payload.profiles
    || payload.yamlContent
    || payload.yaml_content
    || payload.content;
}

async function importClashPayload(coreDir, payload) {
  const sourcePayload = getClashSourcePayload(payload);
  let imported = sourcePayload ? importDirectClashRuntimeConfig(coreDir, sourcePayload, 'server-config') : null;
  if (imported?.ok) return imported;
  if (!payload.subscriptionUrl) {
    if (!sourcePayload) return { ok: false, error: '缺少可导入的 Clash 配置内容' };
    return imported || { ok: false, error: '导入 Clash 配置失败' };
  }
  try {
    const content = await fetchSubscriptionContent(payload.subscriptionUrl);
    return content
      ? importDirectClashRuntimeConfig(coreDir, content, 'subscription-url')
      : { ok: false, error: '订阅链接返回空内容', rawContent: '' };
  } catch (error) {
    return { ok: false, error: clashError(error), rawContent: sourcePayload || '' };
  }
}

function serializeImportedClashConfig(imported) {
  if (!imported?.ok) return imported || { ok: false, error: '导入 Clash 配置失败' };
  const generatedContentLength = String(imported.generatedContent || '').length;
  return {
    ok: true,
    configPath: imported.runtimeConfigPath,
    runtimeConfigPath: imported.runtimeConfigPath,
    source: imported.source,
    directImport: true,
    refreshed: imported.refreshed === true,
    generatedContentLength,
  };
}

async function ensureClashConfigDir() {
  try {
    const runtimeRoot = getClashMiniRuntimeRoot();
    const oldDir = path.join(path.dirname(runtimeRoot), `${CLASH_MINI_DIR_NAME}-old`);
    const sourceDir = resolveClashMiniCoreDir();
    if (!sourceDir || !fs.existsSync(sourceDir)) return { ok: false, error: `源目录不存在: ${sourceDir}` };
    const exists = fs.existsSync(runtimeRoot);
    if (path.resolve(runtimeRoot) === path.resolve(sourceDir)) {
      fs.mkdirSync(runtimeRoot, { recursive: true });
      return { ok: true, exists, needRestore: false, path: runtimeRoot, copied: false, direct: true };
    }
    if (exists) {
      fs.mkdirSync(oldDir, { recursive: true });
      copyDirectoryRecursive(runtimeRoot, oldDir, { overwrite: true });
    }
    fs.mkdirSync(runtimeRoot, { recursive: true });
    copyDirectoryRecursive(sourceDir, runtimeRoot, { overwrite: true });
    return { ok: true, exists, needRestore: exists, path: runtimeRoot, copied: true };
  } catch (error) {
    return { ok: false, error: clashError(error) };
  }
}

function createTrafficMonitor(context, readCredentials) {
  return createProxyTrafficMonitor({
    httpClient: context.httpClient,
    ui: context.ui,
    readCredentials,
    readTotals: async () => invokeClashMiniControl(getClashMiniRuntimeRoot(), 'get', '/connections', { timeoutMs: 5000 }),
    onExhausted: async (quota) => {
      context.ui?.sendToSide?.('proxy-traffic-exhausted', quota || {});
      await stopClashMiniProcess(context.ui);
    },
    onUnavailable: async (error) => {
      const message = `Mihomo 控制端口不可用：${clashError(error || '连接失败')}`;
      await stopClashMiniProcess(context.ui);
      context.ui?.sendToSide?.('clash-mini-runtime-failed', { message });
    },
  });
}

async function restoreDirectProxy(ui) {
  if (getClashMiniStatus()?.running === true || typeof ui?.applyClashMiniBrowserProxy !== 'function') return;
  await Promise.resolve(ui.applyClashMiniBrowserProxy(false)).catch(() => {});
}

function createStartHandler(context, monitor) {
  return async (_event, options = {}) => {
    try {
      const authorization = await monitor.authorize();
      if (!authorization?.ok) {
        await restoreDirectProxy(context.ui);
        return authorization || { ok: false, error: '流量额度校验失败' };
      }
      const result = await startClashMiniProcess(context.ui, options || {});
      if (result?.ok) monitor.start();
      else await restoreDirectProxy(context.ui);
      return { ...result, quota: authorization.quota || null };
    } catch (error) {
      await restoreDirectProxy(context.ui);
      return { ok: false, error: clashError(error) };
    }
  };
}

function safeClashHandler(callback, fallback = {}) {
  return async (...args) => {
    try {
      return await callback(...args);
    } catch (error) {
      return { ok: false, error: clashError(error), ...fallback };
    }
  };
}

function createCredentialHandlers(context, readCredentials) {
  const readIdentity = async () => ({
    key: String(readCredentials()?.key || '').trim(),
    deviceId: String(await context.computeDeviceId() || '').trim(),
  });
  return {
    getQuota: async () => {
      try {
        const identity = await readIdentity();
        if (!identity.key || !identity.deviceId) return { ok: false, message: '请先在个人中心登录账号' };
        return context.httpClient.getProxyTrafficQuota(identity.key, identity.deviceId);
      } catch (error) {
        return { ok: false, message: clashError(error) };
      }
    },
    redeem: async (_event, input = {}) => {
      try {
        const identity = await readIdentity();
        const code = String(input.code || '').trim();
        if (!identity.key || !identity.deviceId) return { ok: false, message: '请先在个人中心登录账号' };
        if (!code) return { ok: false, message: '请输入流量礼品码' };
        const result = await context.httpClient.redeemProxyTrafficGiftCode(identity.key, identity.deviceId, code);
        if (result?.quota) context.ui?.sendToSide?.('proxy-traffic-quota', result.quota);
        return result;
      } catch (error) {
        return { ok: false, message: clashError(error) };
      }
    },
  };
}

function createClashIpcHandlers(context) {
  try { setRuntimeLicenseCache(context.licenseCache); } catch (_) {}
  const readCredentials = () => context.licenseCache?.getCredentials?.() || {};
  const monitor = createTrafficMonitor(context, readCredentials);
  const credentials = createCredentialHandlers(context, readCredentials);
  return {
    'start-clash-mini': createStartHandler(context, monitor),
    'test-min-latency': safeClashHandler((_event, options = {}) => testClashMiniLowestLatency(context.ui, options || {})),
    'get-clash-mini-proxy-options': safeClashHandler(
      (_event, options = {}) => getClashMiniProxyGroupOptions(context.ui, options || {}),
      { running: false, names: [], current: '' },
    ),
    'switch-clash-mini-proxy': safeClashHandler(
      (_event, options = {}) => switchClashMiniProxyNode(context.ui, options || {}),
      { running: false },
    ),
    'get-clash-mini-status': safeClashHandler(() => getClashMiniStatus(), { running: false }),
    'stop-clash-mini': safeClashHandler(async () => { await monitor.stop(); return stopClashMiniProcess(context.ui); }),
    'get-proxy-traffic-quota': credentials.getQuota,
    'redeem-proxy-traffic-gift-code': credentials.redeem,
    'ensure-clash-config-dir': ensureClashConfigDir,
    'get-clash-config': safeClashHandler(async (_event, identity) => serializeClashConfig(
      await context.httpClient.getClientConfig(identity.key, identity.deviceId),
    )),
    'stop-clash-service': () => stopClashMiniProcess(context.ui),
    'save-clash-config': safeClashHandler(async (_event, payload = {}) => {
      const runtime = await prepareClashMiniRuntimeDirAsync();
      if (!runtime.ok) return { ok: false, error: runtime.error || '未找到 Clash Mini core 目录' };
      return serializeImportedClashConfig(await importClashPayload(runtime.runtimeDir, payload || {}));
    }),
  };
}

module.exports = { createClashIpcHandlers };
