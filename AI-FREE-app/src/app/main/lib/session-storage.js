// 会话存储模块：只保存账号元数据。Cookie/Storage 由独立 Chromium Profile 持久化。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const {
  getCurrentAccountTypeLabel,
  resolveCurrentAccountType,
} = require('../utils/normalizers');
const { createSessionStoragePaths } = require('../features/account/session-storage-paths');

const {
  SESSION_CREDENTIAL_FIELDS,
  ensureSessionsDir,
  findSessionPaths,
  getKeyFolderPath,
  getLegacyRootSessionJsonPath,
  getLegacyRootSessionPath,
  getSessionFileName,
  getSessionFilePath,
  getSessionsDir,
  getStorageRootDir,
  inferSessionLocationInfo,
  isPermanentAccountSession,
  isProtectedSession,
  normalizeFolderPart,
  normalizeKeyFolderName,
  normalizeStorageType,
  pruneEmptyDir,
  walkSessionFiles,
} = createSessionStoragePaths();


function createEmptySession(accountId) {
  return {
    id: accountId, savedAt: null, lastUsedAt: null, serverRecycleTime: '', serverRecycleTimeTs: null,
    serverRecycleTimeIso: '', platform: '', currentPlatform: '', currentUrl: '', account: '',
    storageType: 'server', storageGroup: '', storageGroupLabel: '', cleanupProtected: false,
    currentAccountType: '', currentAccountTypeLabel: '',
  };
}

function providedOrExisting(data, existing, field) {
  return data[field] !== undefined ? data[field] : existing[field];
}

function resolveSaveAccountType(data, existing, storageType) {
  const hasType = data.currentAccountType !== undefined
    && data.currentAccountType !== null
    && String(data.currentAccountType).trim() !== '';
  const label = String(providedOrExisting(data, existing, 'currentAccountTypeLabel') || '').trim();
  const sourceType = hasType ? data.currentAccountType : existing.currentAccountType;
  const type = resolveCurrentAccountType(sourceType, label);
  const finalLabel = label || (storageType === 'custom' ? '绑定账号' : getCurrentAccountTypeLabel(type));
  let cleanupProtected = existing.cleanupProtected === true
    || isPermanentAccountSession(existing)
    || storageType === 'custom';
  if (data.cleanupProtected !== undefined) cleanupProtected = data.cleanupProtected === true;
  if (hasType) cleanupProtected = type === 'one_time';
  return { type, label: finalLabel, cleanupProtected };
}

function createSavedSessionInfo(accountId, data, existing, accountType) {
  const stringField = (field) => String(providedOrExisting(data, existing, field) || '').trim();
  return {
    id: accountId,
    savedAt: existing.savedAt || new Date().toISOString(),
    lastUsedAt: providedOrExisting(data, existing, 'lastUsedAt'),
    serverRecycleTime: providedOrExisting(data, existing, 'serverRecycleTime'),
    serverRecycleTimeTs: providedOrExisting(data, existing, 'serverRecycleTimeTs'),
    serverRecycleTimeIso: providedOrExisting(data, existing, 'serverRecycleTimeIso'),
    platform: stringField('platform'),
    currentPlatform: stringField('currentPlatform'),
    currentUrl: stringField('currentUrl'),
    account: stringField('account'),
    cleanupProtected: accountType.cleanupProtected,
    currentAccountType: accountType.type,
    currentAccountTypeLabel: accountType.label,
  };
}

function removeOtherSessionCopies(accountId, filePath) {
  for (const candidate of findSessionPaths(accountId)) {
    try {
      if (path.resolve(candidate) !== path.resolve(filePath) && fs.existsSync(candidate)) fs.unlinkSync(candidate);
    } catch (_) {}
  }
}

// 保存账号元数据。即使调用方意外传入 Cookie/Storage，也绝不写入磁盘。
function saveSession(accountId, sessionData) {
  try {
    ensureSessionsDir();
    const existing = loadSession(accountId) || createEmptySession(accountId);
    const storageType = normalizeStorageType(sessionData.storageType || existing.storageType || 'server');
    const storageGroup = String(providedOrExisting(sessionData, existing, 'storageGroup') || '').trim();
    const accountType = resolveSaveAccountType(sessionData, existing, storageType);
    const sessionInfo = createSavedSessionInfo(accountId, sessionData, existing, accountType);
    const filePath = getSessionFilePath(accountId, '', storageType, storageGroup);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    removeOtherSessionCopies(accountId, filePath);
    fs.writeFileSync(filePath, JSON.stringify(sessionInfo, null, 2), 'utf8');
    console.log('[SessionStorage] 会话数据已保存到文件:', filePath);
    return true;
  } catch (error) {
    console.error('[SessionStorage] 保存会话文件失败:', error?.message || error);
    return false;
  }
}

function migrateLegacySessionPath(accountId, filePath, sessionInfo, content) {
  const legacyPaths = [getLegacyRootSessionJsonPath(accountId), getLegacyRootSessionPath(accountId)];
  if (!legacyPaths.includes(filePath)) return filePath;
  try {
    const targetPath = getSessionFilePath(accountId, String(sessionInfo.key || '').trim());
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, 'utf8');
    for (const legacyPath of legacyPaths) {
      try { if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath); } catch (_) {}
    }
    return targetPath;
  } catch (_) {
    return filePath;
  }
}

function stripSessionCredentials(sessionInfo, filePath) {
  if (!sessionInfo || typeof sessionInfo !== 'object' || Array.isArray(sessionInfo)) return sessionInfo;
  const stripped = { ...sessionInfo };
  let changed = false;
  if (!String(stripped.account || '').trim() && String(stripped.accountName || '').trim()) {
    stripped.account = String(stripped.accountName).trim();
    changed = true;
  }
  const privateFields = [...SESSION_CREDENTIAL_FIELDS, 'accountName', 'storageType', 'storageGroup', 'storageGroupLabel'];
  for (const field of privateFields) {
    if (!Object.prototype.hasOwnProperty.call(stripped, field)) continue;
    delete stripped[field];
    changed = true;
  }
  if (changed) {
    try { fs.writeFileSync(filePath, JSON.stringify(stripped, null, 2), 'utf8'); } catch (_) {}
  }
  return stripped;
}

function createLegacyArraySession(accountId, locationInfo) {
  const custom = locationInfo.storageType === 'custom';
  return {
    id: accountId, cookies: [], savedAt: null, lastUsedAt: null, serverRecycleTime: '',
    serverRecycleTimeTs: null, serverRecycleTimeIso: '', platform: '', currentPlatform: '',
    currentUrl: '', account: '', key: '', deviceId: '', accountName: '',
    storageType: locationInfo.storageType, storageGroup: locationInfo.storageGroup,
    storageGroupLabel: locationInfo.storageGroupLabel, cleanupProtected: custom,
    currentAccountType: custom ? 'one_time' : '', currentAccountTypeLabel: custom ? '绑定账号' : '',
    current_account_type: '', current_account_type_label: '', browserStorage: [],
  };
}

function resolveLoadedAccountType(sessionInfo, storageType) {
  const resolved = resolveCurrentAccountType(sessionInfo.currentAccountType, sessionInfo.currentAccountTypeLabel);
  const permanent = storageType === 'custom' || sessionInfo.cleanupProtected === true || resolved === 'one_time';
  const type = resolved || (permanent ? 'one_time' : '');
  const label = String(sessionInfo.currentAccountTypeLabel || '').trim()
    || (permanent ? '绑定账号' : getCurrentAccountTypeLabel(type));
  let cleanupProtected = sessionInfo.cleanupProtected === true || storageType === 'custom';
  if (type === 'one_time') cleanupProtected = true;
  if (type === 'shared') cleanupProtected = false;
  return { type, label, cleanupProtected };
}

function createLoadedSessionLocation(sessionInfo, locationInfo, storageType) {
  return {
    platform: String(sessionInfo.platform || '').trim(),
    currentPlatform: String(sessionInfo.currentPlatform || '').trim(),
    currentUrl: String(sessionInfo.currentUrl || '').trim(),
    account: String(sessionInfo.account || sessionInfo.accountName || '').trim(),
    accountName: sessionInfo.accountName || '',
    storageType,
    storageGroup: String(sessionInfo.storageGroup || locationInfo.storageGroup || '').trim(),
    storageGroupLabel: String(sessionInfo.storageGroupLabel || locationInfo.storageGroupLabel || '').trim(),
  };
}

function createLoadedSession(accountId, sessionInfo, locationInfo) {
  const storageType = normalizeStorageType(sessionInfo.storageType || locationInfo.storageType || 'server');
  const accountType = resolveLoadedAccountType(sessionInfo, storageType);
  return {
    id: accountId,
    cookies: [],
    savedAt: sessionInfo.savedAt,
    lastUsedAt: sessionInfo.lastUsedAt,
    serverRecycleTime: sessionInfo.serverRecycleTime || '',
    serverRecycleTimeTs: sessionInfo.serverRecycleTimeTs ?? null,
    serverRecycleTimeIso: sessionInfo.serverRecycleTimeIso || '',
    ...createLoadedSessionLocation(sessionInfo, locationInfo, storageType),
    key: '',
    deviceId: '',
    cleanupProtected: accountType.cleanupProtected,
    currentAccountType: accountType.type,
    currentAccountTypeLabel: accountType.label,
    current_account_type: accountType.type,
    current_account_type_label: accountType.label,
    browserStorage: [],
  };
}

// 从文件读取会话数据
function loadSession(accountId) {
  try {
    ensureSessionsDir();
    const filePath = findSessionPaths(accountId)[0];
    if (!filePath) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    let sessionInfo = JSON.parse(content);
    const locationInfo = inferSessionLocationInfo(filePath);
    const migratedPath = migrateLegacySessionPath(accountId, filePath, sessionInfo, content);
    sessionInfo = stripSessionCredentials(sessionInfo, migratedPath);
    return Array.isArray(sessionInfo)
      ? createLegacyArraySession(accountId, locationInfo)
      : createLoadedSession(accountId, sessionInfo, locationInfo);
  } catch (error) {
    console.error('[SessionStorage] 读取会话文件失败:', error?.message || error);
    return null;
  }
}

// 删除会话文件
function deleteSession(accountId) {
  try {
    ensureSessionsDir();
    const candidatePaths = findSessionPaths(accountId);
    let deleted = false;
    for (const filePath of candidatePaths) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log('[SessionStorage] 会话文件已删除:', filePath);
          deleted = true;
          pruneEmptyDir(path.dirname(filePath));
        }
      } catch (e) {
        console.error('[SessionStorage] 删除会话文件失败:', e?.message || e);
      }
    }
    return deleted;
  } catch (e) {
    console.error('[SessionStorage] 删除会话文件失败:', e?.message || e);
    return false;
  }
}

// 获取所有会话文件ID
function getAllSessionIds() {
  try {
    ensureSessionsDir();
    const sessionsDir = getSessionsDir();
    if (!fs.existsSync(sessionsDir)) {
      return [];
    }
    const ids = walkSessionFiles(sessionsDir, [])
      .filter(filePath => fs.existsSync(filePath) && fs.lstatSync(filePath).isFile())
      .map((filePath) => {
        try {
          const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          const storedId = parsed && !Array.isArray(parsed) ? String(parsed.id || '').trim() : '';
          if (storedId) return storedId;
        } catch (_) {}
        return path.basename(filePath).replace(/\.json$/, '');
      });
    return Array.from(new Set(ids)).sort((a, b) => b.localeCompare(a)); // 按ID降序排列（时间戳大的在前）
  } catch (e) {
    console.error('[SessionStorage] 获取会话文件列表失败:', e?.message || e);
    return [];
  }
}

module.exports = {
  saveSession,
  loadSession,
  deleteSession,
  getAllSessionIds,
  getSessionsDir,
};
