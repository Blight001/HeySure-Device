'use strict';

const { callOptional, firstText } = require('../../../shared/safe-values');

function text(...values) {
  return firstText(...values).trim();
}

function errorMessage(error, fallback = '') {
  return text(error && error.message, error, fallback);
}

function tabValues(ui) {
  const tabs = ui && typeof ui.getTabs === 'function' ? ui.getTabs() : new Map();
  return tabs && typeof tabs.values === 'function' ? Array.from(tabs.values()) : [];
}

function warnCleanupFailure(prefix, result) {
  if (result && result.failedCount > 0) console.warn(prefix, result.failed);
}

function cleanupStartupProfiles(deps) {
  try {
    const result = deps.cleanupOrphanBrowserProfiles(deps.readBrowserHistorySafe(), deps.ui);
    warnCleanupFailure('[IPC] 启动时自动清理孤立 Chromium 环境失败:', result);
  } catch (error) {
    console.warn('[IPC] 启动时无法自动清理孤立 Chromium 环境:', errorMessage(error));
  }
}

function syncSerializedUrls(history, serialized) {
  let changed = false;
  for (const item of serialized) {
    const record = history.find((entry) => entry.id === item.id);
    if (record && item.url && record.url !== item.url) {
      record.url = item.url;
      changed = true;
    }
  }
  return changed;
}

function profileAuditSummary(audit) {
  return audit ? {
    totalCount: audit.totalCount,
    referencedCount: audit.referencedCount,
    orphanCount: audit.orphanCount,
  } : null;
}

async function getBrowserHistory(deps) {
  try {
    const capacity = typeof deps.ui?.getBrowserCapacity === 'function'
      ? await deps.ui.getBrowserCapacity()
      : null;
    const history = deps.syncOpenTabsToBrowserHistory(deps.ui);
    const serialized = deps.serializeBrowserHistory(history, deps.ui);
    if (syncSerializedUrls(history, serialized)) deps.writeBrowserHistorySafe(history);
    const cleanup = deps.cleanupOrphanBrowserProfiles(history, deps.ui);
    warnCleanupFailure('[IPC] 自动清理孤立 Chromium 环境失败:', cleanup);
    const audit = cleanup && cleanup.profileAudit || deps.auditBrowserProfiles(history, deps.ui);
    return { ok: true, history: serialized, profileAudit: profileAuditSummary(audit), capacity };
  } catch (error) {
    return { ok: false, error: errorMessage(error), history: [] };
  }
}

async function cleanupOrphanProfiles(deps, payload) {
  try {
    if (!payload || payload.confirm !== true) throw new Error('清理孤儿 Profile 需要明确确认');
    const history = deps.syncOpenTabsToBrowserHistory(deps.ui);
    const result = deps.cleanupOrphanBrowserProfiles(history, deps.ui, payload.storageIds);
    if (!result) throw new Error('Chromium Profile 管理器不可用');
    return result;
  } catch (error) {
    return { ok: false, error: errorMessage(error), deletedCount: 0 };
  }
}

function browserWindowLimitReached(deps) {
  const snapshot = deps.licenseCache && typeof deps.licenseCache.getSnapshot === 'function'
    ? deps.licenseCache.getSnapshot()
    : {};
  const tabs = deps.ui && typeof deps.ui.getTabs === 'function' ? deps.ui.getTabs() : new Map();
  return !deps.resolveVipAccess(snapshot).isVip && Number(tabs.size || 0) >= deps.FREE_BROWSER_WINDOW_LIMIT;
}

function limitReachedResult(deps) {
  callOptional(deps.ui, 'sendToSide', 'vip-access-required', {
    feature: '更多独立浏览器窗口',
    limit: deps.FREE_BROWSER_WINDOW_LIMIT,
  });
  return {
    ...deps.createVipRequiredResult('更多独立浏览器窗口'),
    error: `普通用户最多同时打开 ${deps.FREE_BROWSER_WINDOW_LIMIT} 个独立浏览器窗口，请前往个人中心开通 VIP`,
  };
}

function independentBrowserRecord(deps, payload, history) {
  const store = deps.readStoreConfigSafe();
  const storedSettings = store && store.aiFreeBrowserSettings;
  const settings = deps.normalizeAiFreeBrowserSettings(
    payload && payload.settings || storedSettings || {},
  );
  const id = deps.createBrowserHistoryId();
  const homepage = settings.homepage && typeof settings.homepage === 'object' ? settings.homepage : {};
  return {
    id,
    name: deps.makeUniqueBrowserName(
      payload && payload.name || deps.DEFAULT_BROWSER_WINDOW_NAME,
      history,
    ),
    url: homepage.mode === 'custom' && homepage.url ? homepage.url : deps.DEFAULT_BROWSER_WINDOW_URL,
    runtimeType: 'chromium',
    settings,
    createdAt: Date.now(),
    lastOpenedAt: Date.now(),
  };
}

function sendCreationEvent(deps, channel, payload) {
  const mainWindow = deps.ui && typeof deps.ui.getMainWindow === 'function'
    ? deps.ui.getMainWindow()
    : null;
  const webContents = mainWindow && mainWindow.webContents;
  if (webContents && typeof webContents.isDestroyed === 'function' && !webContents.isDestroyed()) {
    webContents.send(channel, payload);
  }
}

function completeIndependentBrowser(deps, record, tabId) {
  const history = deps.readBrowserHistorySafe();
  const createdRecord = history.find((item) => item.id === record.id);
  if (createdRecord && createdRecord.lastError) {
    createdRecord.lastError = '';
    deps.writeBrowserHistorySafe(history);
  }
  callOptional(deps.ui, 'sendToSide', 'browser-history-changed');
  sendCreationEvent(deps, 'independent-browser-create-complete', {
    tabId,
    historyId: record.id,
  });
}

function failIndependentBrowser(deps, record, tabId, error) {
  console.error('[BrowserWindow] 后台创建独立浏览器失败:', errorMessage(error));
  const history = deps.readBrowserHistorySafe();
  const failedRecord = history.find((item) => item.id === record.id);
  if (failedRecord) {
    failedRecord.lastError = errorMessage(error);
    deps.writeBrowserHistorySafe(history);
  }
  sendCreationEvent(deps, 'independent-browser-create-failed', {
    tabId,
    historyId: record.id,
    error: errorMessage(error),
  });
  callOptional(deps.ui, 'sendToSide', 'browser-history-changed');
}

function trackIndependentCreation(deps, state, creation, record, tabId, token) {
  void Promise.resolve(creation)
    .then((createdTabId) => {
      if (!createdTabId) throw new Error('新建浏览器窗口失败');
      completeIndependentBrowser(deps, record, tabId);
    })
    .catch((error) => failIndependentBrowser(deps, record, tabId, error))
    .finally(() => {
      if (state.independentBrowserCreation
        && state.independentBrowserCreation.token === token) {
        state.independentBrowserCreation = null;
      }
    });
}

async function createIndependentBrowser(deps, state, payload) {
  if (browserWindowLimitReached(deps)) return limitReachedResult(deps);
  if (state.independentBrowserCreation) {
    return { ...state.independentBrowserCreation.response, deduplicated: true };
  }
  let history = [];
  let record = null;
  try {
    if (!deps.ui || typeof deps.ui.addTab !== 'function') throw new Error('新建浏览器窗口功能不可用');
    history = deps.syncOpenTabsToBrowserHistory(deps.ui);
    record = independentBrowserRecord(deps, payload, history);
    history.push(record);
    if (!deps.writeBrowserHistorySafe(history)) throw new Error('浏览器历史未能写入本地配置');
    const tabId = `browser-tab-${record.id.replace(/[^a-z0-9_-]/gi, '_')}`;
    const creation = deps.ui.addTab(record.url, {
      tabId,
      fixedTitle: record.name,
      browserHistoryId: record.id,
      runtimeType: 'chromium',
      browserSettings: record.settings,
      resolveProfileInBackground: true,
      showLoadingPage: true,
      focusBrowser: false,
    });
    const response = { ok: true, pending: true, tabId, historyId: record.id, name: record.name };
    const token = {};
    state.independentBrowserCreation = { response, token };
    trackIndependentCreation(deps, state, creation, record, tabId, token);
    callOptional(deps.ui, 'sendToSide', 'browser-history-changed');
    return response;
  } catch (error) {
    if (record) deps.writeBrowserHistorySafe(history.filter((item) => item.id !== record.id));
    return { ok: false, error: errorMessage(error) };
  }
}

function selectedRenameRecords(history, payload) {
  const source = payload && Array.isArray(payload.historyIds) ? payload.historyIds : [];
  const historyIds = [...new Set(source.map((id) => text(id)).filter(Boolean))];
  if (!historyIds.length) throw new Error('请先选择浏览器记录');
  const records = historyIds.map((historyId) => {
    const record = history.find((item) => item.id === historyId);
    if (!record) throw new Error('部分浏览器历史已不存在，请刷新后重试');
    return record;
  });
  return { historyIds, records };
}

function resolveBatchNames(history, selection, payload, defaultName) {
  const baseName = text(payload && payload.baseName, defaultName);
  const selectedIds = new Set(selection.historyIds);
  const occupied = new Set(history
    .filter((item) => !selectedIds.has(item.id))
    .map((item) => text(item.name).toLocaleLowerCase())
    .filter(Boolean));
  const names = selection.records.map((_record, index) => (
    selection.records.length === 1 ? baseName : `${baseName}[${index + 1}]`
  ));
  const conflicted = names.find((name) => occupied.has(name.toLocaleLowerCase()));
  if (conflicted) throw new Error(`名称“${conflicted}”已存在，请换一个名称前缀`);
  return names;
}

async function renameBrowserHistoryBatch(deps, payload) {
  try {
    const history = deps.syncOpenTabsToBrowserHistory(deps.ui);
    const selection = selectedRenameRecords(history, payload);
    const names = resolveBatchNames(history, selection, payload, deps.DEFAULT_BROWSER_WINDOW_NAME);
    selection.records.forEach((record, index) => { record.name = names[index]; });
    if (!deps.writeBrowserHistorySafe(history)) throw new Error('浏览器名称未能保存');
    const openTabs = tabValues(deps.ui);
    selection.records.forEach((record, index) => {
      const tab = openTabs.find((item) => text(item.browserHistoryId) === record.id);
      if (tab && tab.id && deps.ui && typeof deps.ui.renameTab === 'function') {
        deps.ui.renameTab(tab.id, names[index]);
      }
    });
    callOptional(deps.ui, 'sendToSide', 'browser-history-changed');
    return { ok: true, renamed: selection.records.map((record, index) => ({
      historyId: record.id,
      name: names[index],
    })) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function closeHistoryTab(deps, historyId) {
  const tab = tabValues(deps.ui).find((item) => text(item.browserHistoryId) === historyId) || null;
  if (!tab || !tab.id) return null;
  if (!deps.ui || typeof deps.ui.closeTab !== 'function') throw new Error('当前浏览器窗口无法关闭');
  await deps.ui.closeTab(tab.id);
  return tab;
}

function deleteHistoryProfile(deps, record, openTab, latestHistory) {
  const profileId = text(record.profileId, openTab && openTab.id);
  const runtime = deps.ui && deps.ui.browserRuntimeManager;
  if (!profileId || !runtime || typeof runtime.deleteProfile !== 'function') return false;
  try {
    return runtime.deleteProfile(profileId) === true;
  } catch (error) {
    deps.writeBrowserHistorySafe(latestHistory);
    throw new Error(`Chromium Profile 删除失败: ${errorMessage(error)}`);
  }
}

async function deleteBrowserHistory(deps, payload) {
  try {
    const historyId = text(payload && payload.historyId);
    const history = deps.syncOpenTabsToBrowserHistory(deps.ui);
    const record = history.find((item) => item.id === historyId);
    if (!record) throw new Error('浏览器历史不存在');
    const openTab = await closeHistoryTab(deps, historyId);
    const latestHistory = deps.readBrowserHistorySafe();
    const nextHistory = latestHistory.filter((item) => item.id !== historyId);
    if (nextHistory.length === latestHistory.length) throw new Error('浏览器历史不存在');
    if (!deps.writeBrowserHistorySafe(nextHistory)) throw new Error('浏览器历史未能删除');
    const profileDeleted = deleteHistoryProfile(deps, record, openTab, latestHistory);
    callOptional(deps.ui, 'sendToSide', 'browser-history-changed');
    return { ok: true, historyId, name: record.name, closed: Boolean(openTab), profileDeleted };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function createBrowserHistoryIpcHandlers(deps) {
  const state = { independentBrowserCreation: null };
  return {
    cleanupStartupProfiles: () => cleanupStartupProfiles(deps),
    getBrowserHistory: () => getBrowserHistory(deps),
    async showGesturePopup(_event, payload = {}) {
      try { return deps.popup.show(payload); }
      catch (error) { deps.popup.close(); return { ok: false, error: errorMessage(error) }; }
    },
    updateGesturePopup: (_event, payload = {}) => deps.popup.updateSelection(payload),
    closeGesturePopup: () => deps.popup.close(),
    cleanupOrphanProfiles: (_event, payload = {}) => cleanupOrphanProfiles(deps, payload),
    createIndependentBrowser: (_event, payload = {}) => createIndependentBrowser(deps, state, payload),
    async openBrowserHistory(_event, payload = {}) {
      try { return await deps.openBrowserHistoryRecord(deps.ui, payload.historyId); }
      catch (error) { return { ok: false, error: errorMessage(error) }; }
    },
    async renameBrowserHistory(_event, payload = {}) {
      try { return deps.renameBrowserHistoryRecord(deps.ui, payload.historyId, payload.name); }
      catch (error) { return { ok: false, error: errorMessage(error) }; }
    },
    renameBrowserHistoryBatch: (_event, payload = {}) => renameBrowserHistoryBatch(deps, payload),
    deleteBrowserHistory: (_event, payload = {}) => deleteBrowserHistory(deps, payload),
  };
}

module.exports = { createBrowserHistoryIpcHandlers };
