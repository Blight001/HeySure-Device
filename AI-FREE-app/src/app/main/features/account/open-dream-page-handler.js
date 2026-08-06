'use strict';

const { firstText } = require('../../../shared/safe-values');

function text(...values) {
  return firstText(...values).trim();
}

function notify(deps, channel, payload) {
  try {
    if (deps.ui && typeof deps.ui.sendToSide === 'function') deps.ui.sendToSide(channel, payload);
  } catch (_) {}
}

function normalizeRequest(deps, payload) {
  const input = payload || {};
  const platform = text(input.platform, input.platformName);
  const pushed = input.serverPushedData || {};
  return {
    key: text(input.key),
    deviceId: text(input.deviceId),
    requestedAccountId: text(input.accountId),
    platform,
    targetUrl: text(input.targetUrl, deps.resolveDreamTargetUrl()),
    platformName: platform || deps.support.resolveDreamWindowTitle(
      text(pushed.platform_name, pushed.platformName, pushed.platform),
    ),
    fetchResult: null,
    fetchedAccountId: '',
    fetchedCookies: [],
    fetchedBrowserStorage: [],
    subUrls: Array.isArray(input.subUrls) ? input.subUrls : [],
    launchOnly: input.launchOnly === true,
    launchAccountId: text(input.accountId),
    launchAccount: null,
    launchCookies: [],
    launchBrowserStorage: [],
    restoreProfileOnly: false,
    importedNewAccount: false,
  };
}

async function openUrlOnlyPlatform(deps, state) {
  const urls = [state.targetUrl, ...(Array.isArray(state.subUrls) ? state.subUrls : [])]
    .map((url) => text(url))
    .filter((url, index, items) => /^https?:\/\//i.test(url) && items.indexOf(url) === index);
  if (!urls.length) throw new Error('平台没有可用的启动网址');
  const tabId = await deps.ui.addTab(urls[0], {
    fixedTitle: state.platformName,
    tabTitle: state.platformName,
    deferChromiumNavigation: false,
    restoreLastSession: false,
    hideBrowserToolbar: true,
  });
  if (!tabId) throw new Error('浏览器窗口创建失败');
  // 主链接已作为 Chromium 的 initialUrl 启动。浏览器桥接一就绪便立即
  // 批量创建其余标签，不再等待主链接加载、重定向或导航完成。
  const subTabsResult = await openSubUrls(deps, tabId, urls.slice(1), { required: true });
  notify(deps, 'browser-history-changed');
  return {
    ok: true,
    tabId,
    launchOnly: true,
    openedUrls: urls,
    openedWindowCount: 1,
    subTabsResult,
  };
}

function fetchedAccountId(result) {
  const data = result && result.data || {};
  const nested = result && result.result || {};
  return text(
    result && result.account,
    result && result.accountName,
    result && result.username,
    data.account,
    nested.account,
  );
}

async function fetchServerAccount(deps, state) {
  const result = await deps.auth.fetchCookieFromServerForDream(state.key, state.deviceId, {
    platform: state.platform || state.platformName,
    targetUrl: state.targetUrl,
  });
  state.fetchResult = result;
  state.platformName = text(result.platform, result.currentPlatform, state.platformName);
  state.targetUrl = text(result.currentUrl, result.targetUrl, state.targetUrl);
  state.fetchedCookies = Array.isArray(result.cookies) ? result.cookies : [];
  state.fetchedBrowserStorage = Array.isArray(result.browserStorage) ? result.browserStorage : [];
  state.subUrls = Array.isArray(result.subUrls) ? result.subUrls : [];
  state.fetchedAccountId = fetchedAccountId(result);
  if (!state.fetchedAccountId) throw new Error('服务器未返回账号ID，无法判断历史账号');
}

function accountBusinessError(message, code) {
  return Object.assign(new Error(message), { businessError: true, errorCode: code });
}

async function openSubUrls(deps, tabId, urls, options = {}) {
  if (!Array.isArray(urls) || !urls.length) return null;
  const manager = deps.ui && deps.ui.browserRuntimeManager;
  if (!manager || typeof manager.openTabs !== 'function') {
    if (options.required) throw new Error('当前浏览器运行时不支持打开多个网址');
    return null;
  }
  try {
    const result = await manager.openTabs(tabId, 'chromium', urls);
    console.log('[open-dream-page] Chromium 多标签打开结果:', JSON.stringify({ tabId, urls, result }));
    return result;
  } catch (error) {
    if (options.required) {
      throw new Error(`子网址打开失败：${text(error && error.message, error)}`);
    }
    console.warn('[open-dream-page] 子网址打开失败，主站保持可用:', text(error && error.message));
    return null;
  }
}

function useHistoricalAccountAfterExhaustion(deps, state) {
  const account = deps.support.resolveHistoricalDreamAccount({
    key: state.key,
    accountId: state.requestedAccountId,
    requirePermanent: true,
    platform: state.platformName,
  });
  if (!account) throw accountBusinessError('本地无账号', 'ACCOUNT_EMPTY');
  state.launchAccount = account;
  state.launchAccountId = text(account.id, state.launchAccountId);
  state.key = account.key || state.key;
  state.deviceId = account.deviceId || state.deviceId;
  state.restoreProfileOnly = true;
  if (!deps.support.hasPersistedDreamProfile(state.launchAccountId)) {
    throw accountBusinessError('本地账号浏览器环境不存在', 'ACCOUNT_PROFILE_EMPTY');
  }
}

async function fetchOrRestore(deps, state, sourceIsPermanent) {
  try {
    await fetchServerAccount(deps, state);
  } catch (error) {
    if (!sourceIsPermanent || !deps.isUsageExhaustedFetchError(error)) throw error;
    useHistoricalAccountAfterExhaustion(deps, state);
  }
}

function updateHistoricalAccount(deps, state, historical) {
  const result = state.fetchResult;
  if (!result) return historical;
  const updated = deps.accountStorage.updateAccount(text(historical.id), {
    currentUrl: state.targetUrl,
    platform: result.platform || historical.platform,
    currentPlatform: result.currentPlatform || state.platformName || historical.currentPlatform,
    currentAccountType: result.currentAccountType,
    currentAccountTypeLabel: result.currentAccountTypeLabel,
    serverRecycleTime: result.serverRecycleTime,
    serverRecycleTimeTs: result.serverRecycleTimeTs,
    serverRecycleTimeIso: result.serverRecycleTimeIso,
  });
  return updated && updated.ok && updated.account ? updated.account : historical;
}

function resolveHistoricalLaunch(deps, state, sourceIsPermanent) {
  if (state.launchAccount) return;
  const historical = deps.support.resolveHistoricalDreamAccount({
    key: state.key,
    accountId: state.fetchedAccountId || state.requestedAccountId,
    requirePermanent: sourceIsPermanent,
    platform: state.platformName,
  });
  if (!historical) return;
  state.launchAccount = updateHistoricalAccount(deps, state, historical);
  state.launchAccountId = text(historical.id, state.launchAccountId, state.fetchedAccountId);
  state.launchCookies = state.fetchedCookies;
  state.launchBrowserStorage = state.fetchedBrowserStorage;
}

async function reuseOpenTab(deps, state) {
  const activeTab = state.launchAccountId
    ? deps.support.findOpenDreamTab(state.launchAccountId)
    : null;
  if (!activeTab || !activeTab.id) return null;
  if (deps.ui && typeof deps.ui.switchTab === 'function') {
    try { deps.ui.switchTab(activeTab.id); } catch (_) {}
  }
  await deps.support.navigateDreamTab(activeTab.id, state.targetUrl);
  await openSubUrls(deps, activeTab.id, state.subUrls);
  if (state.launchAccountId) {
    deps.accountStorage.updateLastUsedTime(state.launchAccountId);
    notify(deps, 'account-list-updated', {});
  }
  return { ok: true, tabId: activeTab.id, alreadyOpen: true, accountId: state.launchAccountId };
}

function importFetchedAccount(deps, state) {
  const imported = deps.support.importServerFetchedDreamAccount({
    key: state.key,
    deviceId: state.deviceId,
    accountId: state.fetchedAccountId,
    fetchResult: state.fetchResult,
    cookies: state.fetchedCookies,
    browserStorage: state.fetchedBrowserStorage,
    targetUrl: state.targetUrl,
  });
  state.launchAccount = imported.account;
  state.importedNewAccount = true;
  state.launchAccountId = text(imported.accountId, state.launchAccountId, state.fetchedAccountId);
  state.launchCookies = Array.isArray(imported.cookies) ? imported.cookies : state.fetchedCookies;
  state.launchBrowserStorage = Array.isArray(imported.browserStorage)
    ? imported.browserStorage
    : state.fetchedBrowserStorage;
}

function finalizeLaunchAccount(deps, state) {
  if (!state.launchAccount) {
    importFetchedAccount(deps, state);
    notify(deps, 'account-list-updated', {});
  } else {
    deps.accountStorage.updateLastUsedTime(state.launchAccount.id);
    notify(deps, 'account-list-updated', {});
  }
  deps.updateAccountRecycleTimer(
    deps.accountStorage,
    state.launchAccount,
    deps.support.buildAccountCleanupOptions(),
  );
}

function shouldRestoreProfile(deps, state) {
  return state.restoreProfileOnly || (
    !state.importedNewAccount && deps.support.hasPersistedDreamProfile(state.launchAccountId)
  );
}

function validateLaunchState(state, restoreProfile) {
  if (!state.launchAccountId) throw new Error('缺少可用账号ID');
  if (!state.launchAccount) throw new Error('本地无账号');
  const hasCookies = Array.isArray(state.launchCookies) && state.launchCookies.length > 0;
  const hasStorage = Array.isArray(state.launchBrowserStorage) && state.launchBrowserStorage.length > 0;
  if (!restoreProfile && !hasCookies && !hasStorage) throw new Error('本地无账号');
}

function browserName(state) {
  const account = state.launchAccount;
  return text(
    state.platformName,
    account.currentPlatform,
    account.platform,
    account.accountName,
    state.launchAccountId,
  );
}

async function createDreamTab(deps, state, restoreProfile) {
  const tabId = await deps.ui.addTab(state.targetUrl, {
    accountId: state.launchAccountId,
    fixedTitle: browserName(state),
    tabTitle: browserName(state),
    deferChromiumNavigation: false,
    restoreLastSession: restoreProfile,
    hideBrowserToolbar: true,
  });
  if (restoreProfile) {
    await deps.support.navigateDreamTab(tabId, state.targetUrl);
    await openSubUrls(deps, tabId, state.subUrls);
    deps.accountStorage.updateLastUsedTime(state.launchAccountId);
    notify(deps, 'browser-history-changed');
    return { ok: true, tabId, accountId: state.launchAccountId, restored: true };
  }
  await deps.support.navigateDreamTab(tabId, state.targetUrl);
  await deps.ui.browserRuntimeManager.importSession(tabId, {
    cookies: state.launchCookies,
    browserStorage: state.launchBrowserStorage,
    targetUrl: state.targetUrl,
    navigateAfterImport: false,
  });
  await deps.ui.browserRuntimeManager.reload(tabId, 'chromium');
  await openSubUrls(deps, tabId, state.subUrls);
  notify(deps, 'browser-history-changed');
  return { ok: true, tabId };
}

async function openDreamPage(deps, payload) {
  try {
    const state = normalizeRequest(deps, payload);
    if (!state.key) throw new Error('缺少登录状态');
    if (state.launchOnly) return await openUrlOnlyPlatform(deps, state);
    const sourceIsPermanent = deps.support.isPermanentDreamAccount(
      state.requestedAccountId,
      state.key,
    );
    await fetchOrRestore(deps, state, sourceIsPermanent);
    resolveHistoricalLaunch(deps, state, sourceIsPermanent);
    const reused = await reuseOpenTab(deps, state);
    if (reused) return reused;
    finalizeLaunchAccount(deps, state);
    const restoreProfile = shouldRestoreProfile(deps, state);
    validateLaunchState(state, restoreProfile);
    return await createDreamTab(deps, state, restoreProfile);
  } catch (error) {
    return { ok: false, message: text(error && error.message, error) };
  }
}

function createOpenDreamPageHandler(deps) {
  return (_event, payload = {}) => openDreamPage(deps, payload);
}

module.exports = { createOpenDreamPageHandler };
