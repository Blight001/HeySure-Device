// 账号存储模块：整合凭证存储和会话存储
const fs = require('fs');
const path = require('path');
const { getCoreDir, getStorePath } = require('../config');
const sessionStorage = require('./session-storage');
const {
  getCurrentAccountTypeLabel,
  resolveCurrentAccountType,
} = require('../utils/normalizers');
const {
  extractAccountNameFromCookies,
  migrateFromOldStorage: migrateLegacyAccountStorage,
} = require('../features/account/account-storage-migration');
const { loadAccountRecord } = require('../features/account/account-record-loader');
const { callOptional, firstDefined, firstPresent, firstText } = require('../../shared/safe-values');

let runtimeLicenseCache = null;
let storageInitialized = false;
let accountsCache = null;

// 账号记录全部来自 JSON，可安全复制后交给调用方，避免排序或修改数组时污染缓存。
function cloneAccount(account) {
  if (!account || typeof account !== 'object') return account;
  return JSON.parse(JSON.stringify(account));
}

function cloneAccounts(accounts) {
  return Array.isArray(accounts) ? accounts.map(cloneAccount) : [];
}

function upsertCachedAccount(account) {
  if (!Array.isArray(accountsCache) || !account?.id) return;
  const nextAccount = cloneAccount(account);
  // Cookie/Storage 只允许在服务器响应到 Chromium 注入之间短暂存在，
  // 账号索引缓存同样只保存元数据。
  nextAccount.cookies = [];
  nextAccount.browserStorage = [];
  const index = accountsCache.findIndex((item) => item.id === nextAccount.id);
  if (index >= 0) accountsCache[index] = nextAccount;
  else accountsCache.push(nextAccount);
}

function removeCachedAccount(accountId) {
  if (!Array.isArray(accountsCache)) return;
  const normalizedId = String(accountId || '').trim();
  accountsCache = accountsCache.filter((item) => String(item?.id || '').trim() !== normalizedId);
}

// 设置/更新/持久化：setLicenseCache的具体业务逻辑。
function setLicenseCache(next) {
  runtimeLicenseCache = next || null;
}

// 处理：isPermanentAccountRecord的具体业务逻辑。
function isPermanentAccountRecord(account) {
  const currentAccountType = resolveCurrentAccountType(account?.currentAccountType, account?.currentAccountTypeLabel);
  return currentAccountType === 'one_time';
}

// 从分离的存储模块读取完整账号信息（全局凭证+会话合并）
function loadAccountFromFile(accountId) {
  return loadAccountRecord(accountId, {
    getCurrentAccountTypeLabel,
    getRuntimeLicenseCache: () => runtimeLicenseCache,
    isPermanentAccountRecord,
    resolveCurrentAccountType,
    sessionStorage,
  });
}


// 初始化存储目录
function initStorageDirs() {
  if (storageInitialized) return;

  try {
    const storePath = getStorePath();
    console.log('[AccountStorage] 用户凭证存储路径:', storePath);
    console.log('[AccountStorage] 会话数据目录路径:', sessionStorage.getSessionsDir());

    // 每次进程启动只检查一次旧数据迁移；账号列表刷新不应重复初始化。
    migrateFromOldStorage();
    storageInitialized = true;
  } catch (e) {
    console.error('[AccountStorage] 初始化存储目录失败:', e?.message || e);
  }
}

// 从旧的 saved_accounts.json 迁移数据到新的 store/content 存储结构
function migrateFromOldStorage() {
  return migrateLegacyAccountStorage({
    fs,
    path,
    getCoreDir,
    getRuntimeLicenseCache: () => runtimeLicenseCache,
    sessionStorage,
  });
}


// 读取所有账号（基于会话文件）
function loadAccounts() {
  try {
    initStorageDirs();

    if (Array.isArray(accountsCache)) {
      return cloneAccounts(accountsCache);
    }

    // 获取所有会话ID
    const accountIds = sessionStorage.getAllSessionIds();

    // 为每个账号ID加载完整的账号信息
    const accounts = [];
    for (const accountId of accountIds) {
      const accountInfo = loadAccountFromFile(accountId);
      if (accountInfo) {
        accounts.push(accountInfo);
      }
    }

    accountsCache = cloneAccounts(accounts);
    console.log(`[AccountStorage] 首次加载了 ${accounts.length} 个账号，后续读取使用内存缓存`);
    return cloneAccounts(accountsCache);
  } catch (e) {
    console.error('[AccountStorage] 读取账号失败:', e?.message || e);
    return [];
  }
}


function resolveNewAccountCredentials(accountData) {
  let key = firstText(accountData.key);
  const deviceId = firstText(accountData.deviceId);
  const invalidDevice = !deviceId || deviceId === 'unknown';
  if (key && !invalidDevice) return { key, deviceId };
  try {
    const globalCredentials = callOptional(runtimeLicenseCache, 'getCredentials') || { key: '' };
    if (!key && globalCredentials.key) key = globalCredentials.key;
  } catch (error) {
    console.error('[AccountStorage] 读取运行时缓存失败:', error?.message || error);
  }
  return { key, deviceId };
}

function resolveNewAccountType(accountData, storageType) {
  const rawType = firstPresent(accountData.currentAccountType, accountData.current_account_type);
  const rawLabelValue = accountData.currentAccountTypeLabel !== undefined && accountData.currentAccountTypeLabel !== null
    ? accountData.currentAccountTypeLabel
    : firstDefined(accountData.current_account_type_label, '');
  const rawLabel = String(rawLabelValue).trim();
  const currentAccountType = resolveCurrentAccountType(rawType, rawLabel);
  const currentAccountTypeLabel = firstText(rawLabel, getCurrentAccountTypeLabel(currentAccountType));
  const cleanupProtected = currentAccountType
    ? currentAccountType === 'one_time'
    : (accountData.cleanupProtected === true || storageType === 'custom');
  return { cleanupProtected, currentAccountType, currentAccountTypeLabel };
}

function resolveNewAccountRecycleData(accountData) {
  return {
    serverRecycleTime: firstDefined(
      accountData.serverRecycleTime,
      accountData.server_recycle_time,
      accountData.aiAccountExpiryTime,
      accountData.ai_account_expiry_time,
    ),
    serverRecycleTimeTs: firstDefined(accountData.serverRecycleTimeTs, null),
    serverRecycleTimeIso: firstDefined(accountData.serverRecycleTimeIso, ''),
  };
}

function normalizeNewAccount(accountData) {
  const cookies = accountData.cookies || [];
  const accountName = firstText(
    accountData.accountName,
    accountData.account,
    extractAccountNameFromCookies(cookies),
  );
  const storageType = accountData.storageType === 'custom' ? 'custom' : 'server';
  return {
    id: firstText(accountData.accountId, Date.now().toString()),
    credentials: resolveNewAccountCredentials(accountData),
    account: firstText(accountData.account, accountData.accountName, accountName).trim(),
    accountName,
    platform: firstText(accountData.platform).trim(),
    currentPlatform: firstText(accountData.currentPlatform).trim(),
    currentUrl: firstText(accountData.currentUrl).trim(),
    storageType,
    storageGroup: firstText(accountData.storageGroup).trim(),
    storageGroupLabel: firstText(accountData.storageGroupLabel).trim(),
    ...resolveNewAccountType(accountData, storageType),
    ...resolveNewAccountRecycleData(accountData),
  };
}

function saveNewAccountSession(account) {
  return sessionStorage.saveSession(account.id, {
    lastUsedAt: account.lastUsedAt,
    account: account.account,
    accountName: account.accountName,
    platform: account.platform,
    currentPlatform: account.currentPlatform,
    currentUrl: account.currentUrl,
    storageType: account.storageType,
    storageGroup: account.storageGroup,
    storageGroupLabel: account.storageGroupLabel,
    cleanupProtected: account.cleanupProtected,
    currentAccountType: account.currentAccountType,
    currentAccountTypeLabel: account.currentAccountTypeLabel,
    serverRecycleTime: account.serverRecycleTime,
    serverRecycleTimeTs: account.serverRecycleTimeTs,
    serverRecycleTimeIso: account.serverRecycleTimeIso,
  });
}

function buildSavedAccount(account) {
  return {
    id: account.id,
    key: account.credentials.key,
    deviceId: account.credentials.deviceId,
    account: account.account,
    cookies: [],
    browserStorage: [],
    accountName: account.accountName,
    platform: account.platform,
    currentPlatform: account.currentPlatform,
    currentUrl: account.currentUrl,
    storageType: account.storageType,
    storageGroup: account.storageGroup,
    storageGroupLabel: account.storageGroupLabel,
    cleanupProtected: account.cleanupProtected,
    currentAccountType: account.currentAccountType,
    currentAccountTypeLabel: account.currentAccountTypeLabel,
    current_account_type: account.currentAccountType,
    current_account_type_label: account.currentAccountTypeLabel,
    lastUsedAt: account.lastUsedAt,
    serverRecycleTime: account.serverRecycleTime,
    serverRecycleTimeTs: account.serverRecycleTimeTs,
    serverRecycleTimeIso: account.serverRecycleTimeIso,
  };
}

// 添加账号
function addAccount(accountData) {
  try {
    const account = { ...normalizeNewAccount(accountData), lastUsedAt: new Date().toISOString() };
    if (!saveNewAccountSession(account)) {
      console.error('[AccountStorage] 账号保存失败:', account.id);
      return { ok: false, error: '保存账号失败' };
    }
    const savedAccount = buildSavedAccount(account);
    console.log('[AccountStorage] 添加账号成功:', {
      id: account.id,
      hasKey: Boolean(account.credentials.key),
      hasDeviceId: Boolean(account.credentials.deviceId) && account.credentials.deviceId !== 'unknown',
    });
    upsertCachedAccount(savedAccount);
    return {
      ok: true,
      account: cloneAccount(savedAccount)
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

const ACCOUNT_UPDATE_FIELDS = [
  'cookies', 'browserStorage', 'key', 'deviceId', 'accountName', 'platform', 'currentPlatform',
  'currentUrl', 'storageType', 'storageGroup', 'storageGroupLabel', 'cleanupProtected',
  'currentAccountType', 'currentAccountTypeLabel', 'current_account_type', 'current_account_type_label',
  'serverRecycleTime', 'serverRecycleTimeTs', 'serverRecycleTimeIso', 'server_recycle_time',
  'ai_account_expiry_time', 'aiAccountExpiryTime',
];

function hasAccountMetadataUpdate(updates) {
  return ACCOUNT_UPDATE_FIELDS.some((field) => updates[field] !== undefined);
}

function buildAccountSessionUpdates(updates) {
  return {
    account: updates.accountName,
    platform: updates.platform,
    currentPlatform: updates.currentPlatform,
    currentUrl: updates.currentUrl,
    storageType: updates.storageType,
    storageGroup: updates.storageGroup,
    storageGroupLabel: updates.storageGroupLabel,
    cleanupProtected: updates.cleanupProtected,
    currentAccountType: firstDefined(updates.currentAccountType, updates.current_account_type),
    currentAccountTypeLabel: firstDefined(updates.currentAccountTypeLabel, updates.current_account_type_label),
    serverRecycleTime: firstDefined(
      updates.serverRecycleTime, updates.server_recycle_time,
      updates.aiAccountExpiryTime, updates.ai_account_expiry_time,
    ),
    serverRecycleTimeTs: updates.serverRecycleTimeTs,
    serverRecycleTimeIso: updates.serverRecycleTimeIso,
    lastUsedAt: new Date().toISOString(),
  };
}

// 更新账号
function updateAccount(accountId, updates) {
  try {
    // 检查账号是否存在
    const existingAccount = loadAccountFromFile(accountId);
    if (!existingAccount) {
      return { ok: false, error: '账号不存在' };
    }

    // Cookie/Storage 参数只用于兼容调用方，不会写入 account_sessions。
    if (hasAccountMetadataUpdate(updates)) {
      const sessionUpdated = sessionStorage.saveSession(accountId, buildAccountSessionUpdates(updates));

      if (!sessionUpdated) {
        return { ok: false, error: '保存账号更新失败' };
      }
    }

    // 返回更新后的完整账号信息
    const updatedAccount = loadAccountFromFile(accountId);
    upsertCachedAccount(updatedAccount);
    return { ok: true, account: cloneAccount(updatedAccount) };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// 删除账号
function deleteAccount(accountId) {
  try {
    const existingAccount = loadAccountFromFile(accountId);
    if (!existingAccount) {
      return { ok: false, error: '账号不存在' };
    }

    const deleted = sessionStorage.deleteSession(accountId);
    if (!deleted) {
      return { ok: false, error: '删除账号失败' };
    }

    removeCachedAccount(accountId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function buildMigratedSession(account) {
  return {
    lastUsedAt: firstText(account.lastUsedAt, new Date().toISOString()),
    account: firstText(account.account, account.accountName),
    platform: firstText(account.platform),
    currentPlatform: firstText(account.currentPlatform),
    currentUrl: firstText(account.currentUrl),
    storageType: firstText(account.storageType, 'server'),
    storageGroup: firstText(account.storageGroup),
    storageGroupLabel: firstText(account.storageGroupLabel),
    cleanupProtected: account.cleanupProtected === true,
    currentAccountType: firstText(account.currentAccountType),
    currentAccountTypeLabel: firstText(account.currentAccountTypeLabel),
    serverRecycleTime: firstText(account.serverRecycleTime),
    serverRecycleTimeTs: firstDefined(account.serverRecycleTimeTs, null),
    serverRecycleTimeIso: firstText(account.serverRecycleTimeIso),
  };
}

// 处理：migrateAccountId的具体业务逻辑。
function migrateAccountId(oldAccountId, newAccountId) {
  try {
    const sourceId = firstText(oldAccountId).trim();
    const targetId = firstText(newAccountId).trim();
    if (!sourceId || !targetId) {
      return { ok: false, error: '账号ID无效' };
    }
    if (sourceId === targetId) {
      return { ok: true, account: loadAccountFromFile(sourceId) };
    }

    const existingAccount = loadAccountFromFile(sourceId);
    if (!existingAccount) {
      return { ok: false, error: '账号不存在' };
    }

    const saved = sessionStorage.saveSession(targetId, buildMigratedSession(existingAccount));

    if (!saved) {
      return { ok: false, error: '迁移账号失败' };
    }

    if (!sessionStorage.deleteSession(sourceId)) {
      return { ok: false, error: '迁移成功但删除旧账号失败' };
    }

    const migratedAccount = loadAccountFromFile(targetId);
    removeCachedAccount(sourceId);
    upsertCachedAccount(migratedAccount);
    return { ok: true, account: cloneAccount(migratedAccount) };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// 获取单个账号
function getAccount(accountId) {
  try {
    // 从分离存储中读取账号信息
    const account = loadAccountFromFile(accountId);
    if (!account) {
      return { ok: false, error: '账号不存在' };
    }

    return { ok: true, account };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// 获取最后使用的账号（包含完整的key和deviceId）
function getLastUsedAccount() {
  try {
    const accounts = loadAccounts();
    if (accounts.length === 0) {
      return { ok: false, error: '没有保存的账号' };
    }

    // 按id排序（id包含时间戳），最新的在前
    const sortedAccounts = accounts.sort((a, b) => b.id.localeCompare(a.id));

    // 返回第一个（ID最大的，理论上最新的）账号
    const account = sortedAccounts[0];
    return { ok: true, account };
  } catch (e) {
    console.error('[AccountStorage] 获取最后使用的账号失败:', e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

// 更新账号的最后使用时间
function updateLastUsedTime(accountId) {
  try {
    // 检查账号是否存在
    const account = loadAccountFromFile(accountId);
    if (!account) {
      return { ok: false, error: '账号不存在' };
    }

    // 更新会话数据中的最后使用时间
    const lastUsedAt = new Date().toISOString();
    const result = sessionStorage.saveSession(accountId, {
      lastUsedAt: lastUsedAt
    });

    if (result) {
      upsertCachedAccount({ ...account, lastUsedAt });
      console.log('[AccountStorage] 账号最后使用时间已更新:', accountId, lastUsedAt);
      return { ok: true };
    } else {
      return { ok: false, error: '保存最后使用时间失败' };
    }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function resolveAccountDisplayName(account) {
  const id = firstText(account.id);
  if (id.includes('@')) return id;
  const timestamp = Number.parseInt(id, 10);
  if (Number.isNaN(timestamp)) return `账号${id.slice(-6)}`;
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function buildNamedAccount(account) {
  const currentAccountType = resolveCurrentAccountType(account.currentAccountType, account.currentAccountTypeLabel);
  const generatedLabel = currentAccountType === 'one_time' && account.storageType === 'custom'
    ? '绑定账号'
    : getCurrentAccountTypeLabel(currentAccountType);
  const currentAccountTypeLabel = firstText(account.currentAccountTypeLabel, generatedLabel).trim();
  const permanentFallback = account.cleanupProtected === true || account.storageType === 'custom'
    || isPermanentAccountRecord(account);
  const isPermanent = currentAccountType === 'one_time'
    || (currentAccountType !== 'shared' && permanentFallback);
  return {
    ...account,
    displayName: resolveAccountDisplayName(account),
    storageType: firstText(account.storageType, 'server'),
    storageGroupLabel: firstText(account.storageGroupLabel, isPermanent ? '绑定账号分组' : '临时账号分组'),
    currentAccountType,
    currentAccountTypeLabel,
    storageSortOrder: isPermanent ? 0 : 1,
  };
}

function compareNamedAccounts(a, b) {
  if (a.storageSortOrder !== b.storageSortOrder) return a.storageSortOrder - b.storageSortOrder;
  if (a.storageGroupLabel !== b.storageGroupLabel) return a.storageGroupLabel.localeCompare(b.storageGroupLabel, 'zh-CN');
  if (a.lastUsedAt && b.lastUsedAt) return String(b.lastUsedAt).localeCompare(String(a.lastUsedAt));
  if (a.id.includes('@') && b.id.includes('@')) return a.id.localeCompare(b.id);
  return String(b.id).localeCompare(String(a.id));
}

function resolvePublicAccountType(account) {
  const inferredPermanent = account.storageType === 'custom' || account.cleanupProtected === true;
  return firstText(account.currentAccountType, inferredPermanent ? 'one_time' : '');
}

function resolvePublicCleanupProtection(account) {
  if (account.currentAccountType === 'one_time') return true;
  if (account.currentAccountType === 'shared') return false;
  return account.cleanupProtected === true || isPermanentAccountRecord(account);
}

function toPublicAccount(account) {
  const currentAccountType = resolvePublicAccountType(account);
  const inferredLabel = currentAccountType === 'one_time' ? '绑定账号' : '';
  const cookiesCount = Array.isArray(account.cookies) ? account.cookies.length : 0;
  return {
    id: account.id,
    displayName: account.displayName,
    platform: firstText(account.platform),
    key: account.key,
    cleanupProtected: resolvePublicCleanupProtection(account),
    currentAccountType,
    currentAccountTypeLabel: firstText(account.currentAccountTypeLabel, inferredLabel),
    current_account_type: currentAccountType,
    current_account_type_label: firstText(account.currentAccountTypeLabel, inferredLabel),
    hasCookies: cookiesCount > 0,
    cookiesCount,
    lastUsedAt: account.lastUsedAt,
    serverRecycleTime: firstText(account.serverRecycleTime),
    serverRecycleTimeTs: account.serverRecycleTimeTs ?? null,
    serverRecycleTimeIso: firstText(account.serverRecycleTimeIso),
  };
}

// 获取所有账号（不包含敏感信息）
function getAllAccounts() {
  try {
    return loadAccounts().map(buildNamedAccount).sort(compareNamedAccounts).map(toPublicAccount);
  } catch (e) {
    console.error('[AccountStorage] 获取账号列表失败:', e?.message || e);
    return [];
  }
}

module.exports = {
  addAccount,
  updateAccount,
  deleteAccount,
  migrateAccountId,
  getAccount,
  getLastUsedAccount,
  getAllAccounts,
  updateLastUsedTime,
  setLicenseCache,
};
