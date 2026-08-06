'use strict';

const { firstText } = require('../../../shared/safe-values');

function text(...values) {
  return firstText(...values).trim();
}

function cleanupAccountArtifacts(deps, accountId) {
  const ui = deps.ui || {};
  return deps.cleanupAccountProfile(accountId, {
    browserRuntimeManager: ui.browserRuntimeManager,
    getTabs: ui.getTabs,
    closeTab: ui.closeTab,
    fs: deps.fs,
    getStorePath: deps.getStorePath,
    sendToSide: ui.sendToSide,
    logger: console,
  });
}

function buildAccountCleanupOptions(deps) {
  const sendToSide = deps.ui && typeof deps.ui.sendToSide === 'function'
    ? deps.ui.sendToSide
    : null;
  return {
    sendToSide,
    cleanupAccountArtifacts: (accountId) => cleanupAccountArtifacts(deps, accountId),
  };
}

function resolveDreamWindowTitle(deps, fallback = '') {
  try {
    const config = deps.licenseCache && typeof deps.licenseCache.getRuntimeConfig === 'function'
      ? deps.licenseCache.getRuntimeConfig()
      : {};
    const allowed = config && Array.isArray(config.allowedPlatforms) ? config.allowedPlatforms : [];
    return text(config && config.platformName, allowed[0], fallback);
  } catch (_) {
    return text(fallback);
  }
}

function buildPlatformAccountId(platform, accountId) {
  const normalizedPlatform = text(platform);
  const normalizedAccountId = text(accountId);
  return normalizedPlatform && normalizedAccountId
    ? `${normalizedPlatform}::${normalizedAccountId}`
    : normalizedAccountId;
}

function findDreamAccountRecord(deps, accountId = '', key = '') {
  return deps.findAccountRecord(deps.accountStorage, { accountId, key });
}

function isPermanentDreamAccount(deps, accountId = '', key = '') {
  try {
    const account = findDreamAccountRecord(deps, accountId, key);
    return deps.isPermanentAccountRecord(account, { includeProtected: true });
  } catch (_) {
    return false;
  }
}

function targetHistoryPlatform(deps, requestedPlatform) {
  const snapshot = deps.licenseCache && typeof deps.licenseCache.getSnapshot === 'function'
    ? deps.licenseCache.getSnapshot()
    : {};
  return text(
    requestedPlatform,
    snapshot.platformName,
    snapshot.platform,
    snapshot.currentPlatform,
    snapshot.currentPlatformName,
  ).toLowerCase();
}

function readStoredAccount(deps, summary) {
  const accountId = text(summary && summary.id);
  if (!accountId) return null;
  const result = deps.accountStorage.getAccount(accountId);
  return result && result.ok === true && result.account ? result.account : null;
}

function accountMatchesHistory(deps, account, summary, criteria) {
  const accountId = text(account.id);
  const identity = text(account.account, account.accountName);
  if (criteria.accountId && accountId !== criteria.accountId && identity !== criteria.accountId) return false;
  const accountKey = text(account.key);
  if (criteria.key && accountKey && accountKey !== criteria.key) return false;
  if (criteria.requirePermanent && !deps.isPermanentAccountRecord(account, { includeProtected: true })) return false;
  if (!criteria.platform) return true;
  const platform = text(
    account.platform,
    account.currentPlatform,
    summary && summary.platform,
    summary && summary.currentPlatform,
  ).toLowerCase();
  return !platform || platform === criteria.platform;
}

function mostRecentAccount(accounts) {
  accounts.sort((left, right) => {
    const timeDifference = (Date.parse(text(right.lastUsedAt)) || 0) - (Date.parse(text(left.lastUsedAt)) || 0);
    return timeDifference || text(left.id).localeCompare(text(right.id));
  });
  return accounts[0] || null;
}

function resolveHistoricalDreamAccount(deps, options = {}) {
  try {
    const summaries = typeof deps.accountStorage.getAllAccounts === 'function'
      ? deps.accountStorage.getAllAccounts()
      : [];
    const criteria = {
      key: text(options.key),
      accountId: text(options.accountId),
      requirePermanent: options.requirePermanent === true,
      platform: targetHistoryPlatform(deps, options.platform),
    };
    const accounts = [];
    for (const summary of summaries) {
      const account = readStoredAccount(deps, summary);
      if (account && accountMatchesHistory(deps, account, summary, criteria)) accounts.push(account);
    }
    return mostRecentAccount(accounts);
  } catch (error) {
    console.warn('[open-dream-page] 读取历史账号失败:', text(error && error.message, error));
    return null;
  }
}

function findOpenDreamTab(deps, accountId = '') {
  try {
    const tabs = deps.ui && typeof deps.ui.getTabs === 'function' ? deps.ui.getTabs() : new Map();
    const targetId = text(accountId);
    for (const tab of tabs.values()) {
      if (targetId && text(tab && tab.accountId) === targetId) return tab;
    }
  } catch (_) {}
  return null;
}

function navigationCanContinue(error) {
  const code = error && error.code;
  if (code === 'NAVIGATION_TIMEOUT' || code === 'RUNTIME_COMMAND_TIMEOUT') return true;
  if (code !== 'NAVIGATION_FAILED') return false;
  const message = text(error && error.message);
  return /页面加载失败:\s*-3(?:\s|$)/.test(message) || /ERR_ABORTED/i.test(message);
}

async function navigateDreamTab(deps, tabId, rawTargetUrl) {
  const targetUrl = text(rawTargetUrl);
  if (!/^https?:\/\//i.test(targetUrl)) {
    throw new Error('服务器下发的平台网址无效，请联系管理员检查目标地址');
  }
  try {
    await deps.ui.browserRuntimeManager.navigate(tabId, 'chromium', targetUrl);
  } catch (error) {
    if (!navigationCanContinue(error)) throw error;
    console.warn('[open-dream-page] 目标页仍在加载或正在重定向，继续后续流程:', text(error.message));
  }
}

function hasPersistedDreamProfile(deps, accountId = '') {
  try {
    const ui = deps.ui || {};
    const runtime = ui.browserRuntimeManager || {};
    const store = runtime.store;
    if (!store || typeof store.readProfile !== 'function') return false;
    const profile = store.readProfile(text(accountId));
    return Boolean(profile && profile.createdAt);
  } catch (_) {
    return false;
  }
}

function fetchedAccountInput(data) {
  const result = data.fetchResult || {};
  const browserStorage = Array.isArray(data.browserStorage) ? data.browserStorage : [];
  return {
    key: data.key,
    deviceId: data.deviceId,
    cookies: Array.isArray(data.cookies) ? data.cookies : [],
    browserStorage: browserStorage.length ? browserStorage : undefined,
    accountId: buildPlatformAccountId(result.platform || result.currentPlatform, data.accountId),
    accountName: data.accountId,
    account: data.accountId,
    platform: result.platform,
    currentPlatform: result.currentPlatform,
    currentUrl: result.currentUrl || data.targetUrl,
    currentAccountType: result.currentAccountType,
    currentAccountTypeLabel: result.currentAccountTypeLabel,
    current_account_type: result.currentAccountType,
    current_account_type_label: result.currentAccountTypeLabel,
    serverRecycleTime: result.serverRecycleTime,
    serverRecycleTimeTs: result.serverRecycleTimeTs,
    serverRecycleTimeIso: result.serverRecycleTimeIso,
    server_recycle_time: result.serverRecycleTime,
    ai_account_expiry_time: result.serverRecycleTime,
    aiAccountExpiryTime: result.serverRecycleTime,
  };
}

function importServerFetchedDreamAccount(deps, data) {
  const saveResult = deps.accountStorage.addAccount(fetchedAccountInput(data));
  if (!saveResult.ok || !saveResult.account) throw new Error(saveResult.error || '账号保存失败');
  return {
    account: saveResult.account,
    accountId: text(saveResult.account.id, data.accountId),
    cookies: Array.isArray(data.cookies) ? data.cookies : [],
    browserStorage: Array.isArray(data.browserStorage) ? data.browserStorage : [],
  };
}

function parseTcpAddress(rawAddress) {
  const address = text(rawAddress);
  if (!address) return null;
  try {
    const parsed = new URL(address.includes('://') ? address : `tcp://${address}`);
    const port = Number.parseInt(parsed.port, 10) || 0;
    return parsed.hostname && port > 0 ? { host: text(parsed.hostname), port } : null;
  } catch (_) {
    const stripped = address.replace(/^tcp:\/\//i, '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const [host, rawPort] = stripped.split(':');
    const port = Number.parseInt(rawPort, 10) || 0;
    return text(host) && port > 0 ? { host: text(host), port } : null;
  }
}

function resolveRuntimeConnectionConfig(source = {}) {
  const config = /** @type {Record<string, any>} */ (
    source && typeof source === 'object' ? source : {}
  );
  return {
    serverBase: text(
      config.serverBase,
      config.server_base,
      config.address_HTTP,
      config.addressHttp,
      config.address_http,
      config.client_address,
      config.clientAddress,
      config.address,
    ),
    tcp: parseTcpAddress(config.address_TCP || config.addressTcp || config.address_tcp),
  };
}

function createDreamPlatformSupport(deps) {
  return {
    buildAccountCleanupOptions: () => buildAccountCleanupOptions(deps),
    findOpenDreamTab: (accountId) => findOpenDreamTab(deps, accountId),
    hasPersistedDreamProfile: (accountId) => hasPersistedDreamProfile(deps, accountId),
    importServerFetchedDreamAccount: (data) => importServerFetchedDreamAccount(deps, data),
    isPermanentDreamAccount: (accountId, key) => isPermanentDreamAccount(deps, accountId, key),
    navigateDreamTab: (tabId, targetUrl) => navigateDreamTab(deps, tabId, targetUrl),
    resolveDreamWindowTitle: (fallback) => resolveDreamWindowTitle(deps, fallback),
    resolveHistoricalDreamAccount: (options) => resolveHistoricalDreamAccount(deps, options),
    resolveRuntimeConnectionConfig,
  };
}

module.exports = { createDreamPlatformSupport, resolveRuntimeConnectionConfig };
