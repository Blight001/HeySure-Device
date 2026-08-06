// 统一清理账号的独立 Chromium Profile 和关联浏览器历史。

function removeAccountBrowserHistory(accountId, deps = {}) {
  const { fs, getStorePath, logger = console } = deps;
  try {
    const storePath = typeof getStorePath === 'function' ? getStorePath() : '';
    if (!storePath || !fs?.existsSync?.(storePath)) return true;
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8') || '{}');
    const history = Array.isArray(store.browserHistory) ? store.browserHistory : [];
    const nextHistory = history.filter((record) => (
      String(record?.accountId || '').trim() !== accountId
    ));
    if (nextHistory.length === history.length) return true;
    fs.writeFileSync(storePath, JSON.stringify({ ...store, browserHistory: nextHistory }, null, 2), 'utf8');
    return true;
  } catch (error) {
    logger.warn?.('[AccountProfileCleanup] 删除关联浏览器历史失败:', accountId, error?.message || error);
    return false;
  }
}

const cleanupInFlight = new Map();

async function closeAccountTabs(accountId, deps) {
  const tabs = typeof deps.getTabs === 'function' ? deps.getTabs() : new Map();
  const matchedTabs = Array.from(tabs && typeof tabs.values === 'function' ? tabs.values() : [])
    .filter((tab) => String((tab && tab.accountId) || '').trim() === accountId);
  if (typeof deps.closeTab !== 'function') return;
  for (const tab of matchedTabs) {
    if (tab && tab.id) await deps.closeTab(tab.id);
  }
}

async function stopAccountRuntime(accountId, browserRuntimeManager) {
  if (!browserRuntimeManager || typeof browserRuntimeManager.getState !== 'function') return;
  const state = browserRuntimeManager.getState(accountId);
  const status = String((state && state.status) || '').toLowerCase();
  if (state && !['stopped', 'crashed'].includes(status)) {
    await browserRuntimeManager.stop(accountId, 'chromium', { timeoutMs: 5000 });
  }
}

async function deleteAccountProfile(accountId, browserRuntimeManager) {
  if (browserRuntimeManager && typeof browserRuntimeManager.deleteProfileAsync === 'function') {
    await browserRuntimeManager.deleteProfileAsync(accountId);
    return true;
  }
  if (browserRuntimeManager && typeof browserRuntimeManager.deleteProfile === 'function') {
    await browserRuntimeManager.deleteProfile(accountId);
    return true;
  }
  return false;
}

function notifyAccountProfileCleanup(accountId, sendToSide, logger) {
  try {
    if (typeof sendToSide === 'function') sendToSide('browser-history-changed');
  } catch (_) {}
  if (logger && typeof logger.log === 'function') {
    logger.log('[AccountProfileCleanup] 已删除账号 Chromium Profile:', accountId);
  }
}

function cleanupAccountProfile(accountId, deps = {}) {
  const normalizedAccountId = String(accountId || '').trim();
  if (!normalizedAccountId) return Promise.resolve({ ok: false, error: '缺少账号ID' });
  if (cleanupInFlight.has(normalizedAccountId)) return cleanupInFlight.get(normalizedAccountId);

  const operation = runAccountProfileCleanup(normalizedAccountId, deps)
    .finally(() => cleanupInFlight.delete(normalizedAccountId));
  cleanupInFlight.set(normalizedAccountId, operation);
  return operation;
}

async function runAccountProfileCleanup(normalizedAccountId, deps = {}) {
  const {
    browserRuntimeManager,
    logger = console,
    sendToSide,
  } = deps;

  try {
    await closeAccountTabs(normalizedAccountId, deps);
    await stopAccountRuntime(normalizedAccountId, browserRuntimeManager);
    if (!await deleteAccountProfile(normalizedAccountId, browserRuntimeManager)) {
      return { ok: false, error: 'Chromium Profile 管理器不可用' };
    }

    if (!removeAccountBrowserHistory(normalizedAccountId, deps)) {
      return { ok: false, error: '浏览器历史清理失败' };
    }

    notifyAccountProfileCleanup(normalizedAccountId, sendToSide, logger);
    return { ok: true, accountId: normalizedAccountId };
  } catch (error) {
    const message = error && error.message ? error.message : error;
    if (logger && typeof logger.warn === 'function') {
      logger.warn('[AccountProfileCleanup] 删除账号 Chromium Profile 失败:', normalizedAccountId, message);
    }
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

module.exports = {
  cleanupAccountProfile,
  removeAccountBrowserHistory,
};
