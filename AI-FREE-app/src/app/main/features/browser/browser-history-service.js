'use strict';

const accountStorage = require('../../lib/account-storage');
const { buildManagedTabPartitionName } = require('../../services/tab-common');
const { resolveRecycleTimestamp } = require('../../utils/accountCleanup');
const {
  getCurrentAccountTypeLabel,
  resolveCurrentAccountType,
} = require('../../utils/normalizers');
const {
  readStoreConfigSafe,
  writeStoreConfigSafe,
} = require('../../ipc/register/store-utils');
const { normalizeAiFreeBrowserSettings } = require('../../utils/ai-free-browser-settings');
const { callOptional, firstText } = require('../../../shared/safe-values');

const DEFAULT_BROWSER_WINDOW_NAME = '新建窗口';
const DEFAULT_BROWSER_WINDOW_URL = 'chrome://newtab/';

function text(...values) {
  return firstText(...values).trim();
}

function resolveHistoryHideToolbar(item, accountId) {
  const hasPreference = Object.prototype.hasOwnProperty.call(item, 'hideToolbar')
    || Object.prototype.hasOwnProperty.call(item, 'hideBrowserToolbar');
  if (hasPreference) return item.hideToolbar === true || item.hideBrowserToolbar === true;
  return Boolean(accountId);
}

function normalizeBrowserHistoryItem(value) {
  const item = value && typeof value === 'object' ? value : {};
  const partition = text(item.partition);
  const accountId = text(item.accountId);
  return {
    ...item,
    id: text(item.id),
    name: text(item.name, DEFAULT_BROWSER_WINDOW_NAME) || DEFAULT_BROWSER_WINDOW_NAME,
    url: text(item.url),
    profileId: text(item.profileId),
    accountId,
    ...(partition ? { partition } : {}),
    runtimeType: 'chromium',
    hideToolbar: resolveHistoryHideToolbar(item, accountId),
    lastError: text(item.lastError),
    settings: normalizeAiFreeBrowserSettings(item.settings || {}),
    createdAt: Number(item.createdAt || 0) || Date.now(),
    lastOpenedAt: Number(item.lastOpenedAt || 0) || Number(item.createdAt || 0) || Date.now(),
  };
}

function accountSummaryMaps(summaries) {
  return {
    byPartition: new Map(summaries.map((summary) => [
      `persist:${buildManagedTabPartitionName(summary && summary.id)}`,
      summary,
    ])),
    byId: new Map(summaries.map((summary) => [text(summary && summary.id), summary])),
  };
}

function migrateBrowserHistoryAccounts(history, summaries) {
  const maps = accountSummaryMaps(summaries);
  let changed = false;
  for (const record of history) {
    if (!record.accountId) {
      const summary = maps.byId.get(record.profileId) || maps.byPartition.get(record.partition);
      const accountId = text(summary && summary.id);
      if (accountId) {
        const result = accountStorage.getAccount(accountId);
        const account = result && result.ok ? result.account : null;
        if (!record.profileId) record.profileId = accountId;
        record.accountId = accountId;
        record.hideToolbar = true;
        if (!record.url && account && account.currentUrl) record.url = text(account.currentUrl);
        changed = true;
      }
    }
    if (record.partition) {
      delete record.partition;
      changed = true;
    }
  }
  return changed;
}

function readBrowserHistorySafe() {
  const store = readStoreConfigSafe();
  const source = store && Array.isArray(store.browserHistory) ? store.browserHistory : [];
  const history = source.map(normalizeBrowserHistoryItem).filter((item) => item.id);
  let changed = source.some((item) => (
    text(item && item.runtimeType) !== 'chromium'
    || (text(item && item.accountId)
      && !Object.prototype.hasOwnProperty.call(item, 'hideToolbar')
      && !Object.prototype.hasOwnProperty.call(item, 'hideBrowserToolbar'))
  ));
  try {
    const summaries = typeof accountStorage.getAllAccounts === 'function'
      ? accountStorage.getAllAccounts()
      : [];
    changed = migrateBrowserHistoryAccounts(history, summaries) || changed;
  } catch (_) {}
  if (changed) {
    writeStoreConfigSafe({
      ...(store && typeof store === 'object' ? store : {}),
      browserHistory: history,
    });
  }
  return history;
}

function writeBrowserHistorySafe(history) {
  const currentStore = readStoreConfigSafe();
  return writeStoreConfigSafe({
    ...(currentStore && typeof currentStore === 'object' ? currentStore : {}),
    browserHistory: Array.isArray(history) ? history : [],
  });
}

function createBrowserHistoryId() {
  return `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeUniqueBrowserName(requestedName, history = [], excludeId = '') {
  const base = String(requestedName || '').trim() || DEFAULT_BROWSER_WINDOW_NAME;
  const occupied = new Set(history
    .filter((item) => String(item?.id || '') !== String(excludeId || ''))
    .map((item) => String(item?.name || '').trim().toLocaleLowerCase())
    .filter(Boolean));
  if (!occupied.has(base.toLocaleLowerCase())) return base;
  let suffix = 2;
  while (occupied.has(`${base}[${suffix}]`.toLocaleLowerCase())) suffix += 1;
  return `${base}[${suffix}]`;
}

function getManagedTabUrl(tab) {
  const runtimeUrl = text(tab && tab.runtimeUrl);
  if (runtimeUrl && runtimeUrl !== 'about:blank' && !runtimeUrl.startsWith('data:text/html')) {
    return runtimeUrl;
  }
  return text(tab && tab.requestedUrl);
}

function tabValues(ui) {
  const tabs = ui && typeof ui.getTabs === 'function' ? ui.getTabs() : new Map();
  return tabs && typeof tabs.values === 'function' ? tabs.values() : [];
}

function findTabHistoryRecord(history, tab) {
  let historyId = text(tab && tab.browserHistoryId);
  let record = history.find((item) => item.id === historyId) || null;
  const accountId = text(tab && tab.accountId);
  const profileId = text(tab && tab.id);
  if (!record && accountId) {
    record = history.find((item) => (
      text(item.accountId) === accountId || text(item.profileId) === profileId
    )) || null;
    if (record) historyId = record.id;
  }
  return { accountId, historyId, profileId, record };
}

function createHistoryRecord(history, tab, match) {
  const historyId = createBrowserHistoryId();
  const title = text(tab && tab.fixedTitle, tab && tab.runtimeTitle);
  const record = {
    id: historyId,
    name: makeUniqueBrowserName(title || DEFAULT_BROWSER_WINDOW_NAME, history),
    kind: tab && tab.isTutorialTab === true ? 'tutorial' : '',
    url: getManagedTabUrl(tab),
    profileId: match.profileId,
    accountId: match.accountId,
    runtimeType: 'chromium',
    hideToolbar: tab && tab.hideBrowserToolbar === true,
    settings: normalizeAiFreeBrowserSettings(tab && tab.browserSettings || {}),
    createdAt: Date.now(),
    lastOpenedAt: Date.now(),
  };
  history.push(record);
  tab.browserHistoryId = historyId;
}

function updateHistoryRecord(tab, match) {
  const record = match.record;
  const liveUrl = getManagedTabUrl(tab);
  const updates = {
    profileId: match.profileId,
    accountId: match.accountId,
    hideToolbar: tab && tab.hideBrowserToolbar === true,
  };
  if (liveUrl) updates.url = liveUrl;
  if (tab && tab.isTutorialTab === true) updates.kind = 'tutorial';
  let changed = false;
  for (const [field, value] of Object.entries(updates)) {
    if (record[field] !== value) {
      record[field] = value;
      changed = true;
    }
  }
  if (tab.browserHistoryId !== match.historyId) {
    tab.browserHistoryId = match.historyId;
    changed = true;
  }
  return changed;
}

function syncOpenTabsToBrowserHistory(ui) {
  const history = readBrowserHistorySafe();
  let changed = false;
  for (const tab of tabValues(ui)) {
    const match = findTabHistoryRecord(history, tab);
    if (!match.record) {
      createHistoryRecord(history, tab, match);
      changed = true;
    } else changed = updateHistoryRecord(tab, match) || changed;
  }
  if (changed) {
    writeBrowserHistorySafe(history);
    ui?.updateTabs?.(true);
  }
  return history;
}

function buildBrowserHistoryAccountMeta(account = {}) {
  const accountId = text(account && account.id);
  if (!accountId) return null;
  const accountType = resolveCurrentAccountType(
    account.currentAccountType || account.current_account_type,
    account.currentAccountTypeLabel || account.current_account_type_label,
  );
  const accountTypeLabel = text(
    account.currentAccountTypeLabel,
    account.current_account_type_label,
    getCurrentAccountTypeLabel(accountType),
  );
  return {
    accountDisplayName: text(account.displayName, account.accountName, accountId) || accountId,
    accountPlatform: text(account.platform, account.platformName),
    accountType,
    accountTypeLabel,
    autoDeleteAt: accountType === 'shared' ? resolveRecycleTimestamp(account) : null,
  };
}

function findOpenHistoryTab(ui, record, historyId) {
  return Array.from(tabValues(ui)).find((tab) => (
    text(tab && tab.browserHistoryId) === historyId
    || (record.profileId && text(tab && tab.id) === record.profileId)
    || (record.accountId && text(tab && tab.accountId) === record.accountId)
  ));
}

function serializeBrowserHistory(history, ui) {
  const activeTabId = String(typeof ui?.getActiveTabId === 'function' ? ui.getActiveTabId() || '' : '');
  const tabs = Array.from((typeof ui?.getTabs === 'function' ? ui.getTabs() : new Map()).values());
  const accountMetaById = new Map(
    (typeof accountStorage.getAllAccounts === 'function' ? accountStorage.getAllAccounts() : [])
      .map((account) => /** @type {[string, any]} */ ([String(account?.id || '').trim(), buildBrowserHistoryAccountMeta(account)]))
      .filter(([accountId, meta]) => accountId && meta),
  );
  return history
    .map((record) => {
      const openTab = tabs.find((tab) => String(tab?.browserHistoryId || '') === record.id) || null;
      const liveUrl = openTab ? getManagedTabUrl(openTab) : '';
      return {
        ...record,
        ...(accountMetaById.get(String(record.accountId || '').trim()) || {}),
        url: liveUrl || record.url,
        tabId: openTab ? String(openTab.id || '') : '',
        isOpen: !!openTab,
        isActive: !!openTab && String(openTab.id || '') === activeTabId,
        networkMagicActive: !!openTab && openTab.networkMagicApplied === true,
      };
    })
    .sort((left, right) => Number(right.lastOpenedAt || 0) - Number(left.lastOpenedAt || 0));
}

// 打开一条浏览器窗口记录（已打开则切换激活）。被 open-browser-history IPC
// 和 AI 默认窗口工具（services/ai-browser-window-tools）共用，改动需两边兼容。
async function openBrowserHistoryRecord(ui, historyIdInput) {
  const history = syncOpenTabsToBrowserHistory(ui);
  const historyId = String(historyIdInput || '').trim();
  const record = history.find((item) => item.id === historyId);
  if (!record) throw new Error('浏览器历史不存在');
  const openTab = findOpenHistoryTab(ui, record, historyId);
  let tabId = openTab && openTab.id;
  if (tabId) {
    callOptional(ui, 'switchTab', tabId);
  } else {
    tabId = record.profileId
      || record.accountId
      || `browser-tab-${record.id.replace(/[^a-z0-9_-]/gi, '_')}`;
    const openUrl = record.url || (record.accountId ? 'about:blank' : DEFAULT_BROWSER_WINDOW_URL);
    tabId = await ui.addTab(openUrl, {
      tabId,
      accountId: record.accountId,
      fixedTitle: record.name,
      browserHistoryId: record.id,
      runtimeType: 'chromium',
      browserSettings: record.settings,
      hideBrowserToolbar: record.hideToolbar === true,
      resolveProfileInBackground: true,
      showLoadingPage: true,
      restoreLastSession: true,
    });
  }
  record.lastOpenedAt = Date.now();
  writeBrowserHistorySafe(history);
  callOptional(ui, 'sendToSide', 'browser-history-changed');
  return {
    ok: true,
    tabId: String(tabId || ''),
    historyId,
    name: record.name,
    alreadyOpen: Boolean(openTab && openTab.id),
  };
}

function applyBrowserHistoryRecordChanges(record, history, historyId, changes) {
  const nameProvided = Object.prototype.hasOwnProperty.call(changes, 'name');
  const settingsProvided = Object.prototype.hasOwnProperty.call(changes, 'settings');
  if (nameProvided) record.name = makeUniqueBrowserName(changes.name, history, historyId);
  if (settingsProvided) record.settings = normalizeAiFreeBrowserSettings(changes.settings || {});
  return { nameProvided };
}

function syncEditedOpenTab(ui, record, historyId, nameProvided) {
  const openTab = findOpenHistoryTab(ui, record, historyId);
  if (nameProvided && openTab?.id && typeof ui?.renameTab === 'function') {
    ui.renameTab(openTab.id, record.name);
  }
  return openTab;
}

// 编辑一条浏览器窗口记录，并同步已打开标签页的标题。
function editBrowserHistoryRecord(ui, historyIdInput, changes = {}) {
  const history = syncOpenTabsToBrowserHistory(ui);
  const historyId = String(historyIdInput || '').trim();
  const record = history.find((item) => item.id === historyId);
  if (!record) throw new Error('浏览器历史不存在');
  const previousName = record.name;
  const applied = applyBrowserHistoryRecordChanges(record, history, historyId, changes);
  if (!writeBrowserHistorySafe(history)) throw new Error('浏览器配置未能保存');
  const openTab = syncEditedOpenTab(ui, record, historyId, applied.nameProvided);
  ui.sendToSide?.('browser-history-changed');
  return {
    ok: true,
    historyId,
    name: record.name,
    previousName,
    settings: record.settings,
    tabId: String(openTab?.id || ''),
  };
}

// 保留设置页 IPC 的重命名契约；AI 工具使用上面的 edit 统一编辑名称与环境。
function renameBrowserHistoryRecord(ui, historyIdInput, requestedName) {
  return editBrowserHistoryRecord(ui, historyIdInput, { name: requestedName });
}

function collectBrowserProfileReferences(history = [], ui = null) {
  const references = new Set();
  const remember = (value) => {
    const id = String(value || '').trim();
    if (id) references.add(id);
  };
  for (const record of history) {
    remember(record && record.profileId);
    remember(record && record.accountId);
  }
  for (const tab of tabValues(ui)) {
    remember(tab && tab.id);
    remember(tab && tab.accountId);
  }
  try {
    const accounts = typeof accountStorage.getAllAccounts === 'function'
      ? accountStorage.getAllAccounts()
      : [];
    for (const account of accounts) remember(account && account.id);
  } catch (_) {}
  return Array.from(references);
}

function auditBrowserProfiles(history = [], ui = null) {
  const store = ui?.browserRuntimeManager?.store;
  if (!store || typeof store.auditProfiles !== 'function') return null;
  return store.auditProfiles(collectBrowserProfileReferences(history, ui));
}

function cleanupOrphanBrowserProfiles(history = [], ui = null, storageIds = []) {
  const audit = auditBrowserProfiles(history, ui);
  if (!audit) return null;
  const requestedStorageIds = new Set((Array.isArray(storageIds) ? storageIds : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean));
  const targets = audit.orphanProfiles.filter((profile) => (
    requestedStorageIds.size === 0 || requestedStorageIds.has(profile.storageId)
  ));
  const deleted = [];
  const failed = [];
  for (const profile of targets) {
    const deleteId = profile.profileId || profile.storageId;
    try {
      ui.browserRuntimeManager.deleteProfile(deleteId);
      deleted.push(profile.storageId);
    } catch (error) {
      failed.push({ storageId: profile.storageId, error: error?.message || String(error) });
    }
  }
  return {
    ok: failed.length === 0,
    deletedCount: deleted.length,
    failedCount: failed.length,
    deleted,
    failed,
    profileAudit: auditBrowserProfiles(history, ui),
  };
}

module.exports = {
  DEFAULT_BROWSER_WINDOW_NAME,
  DEFAULT_BROWSER_WINDOW_URL,
  auditBrowserProfiles,
  buildBrowserHistoryAccountMeta,
  cleanupOrphanBrowserProfiles,
  collectBrowserProfileReferences,
  createBrowserHistoryId,
  editBrowserHistoryRecord,
  getManagedTabUrl,
  makeUniqueBrowserName,
  openBrowserHistoryRecord,
  readBrowserHistorySafe,
  renameBrowserHistoryRecord,
  serializeBrowserHistory,
  syncOpenTabsToBrowserHistory,
  writeBrowserHistorySafe,
};
