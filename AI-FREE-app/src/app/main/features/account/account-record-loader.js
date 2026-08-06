'use strict';

const { callOptional, firstText } = require('../../../shared/safe-values');

function readRuntimeCredentials(getRuntimeLicenseCache) {
  try {
    const licenseCache = getRuntimeLicenseCache();
    return callOptional(licenseCache, 'getCredentials') || { key: '' };
  } catch (error) {
    console.error('[AccountStorage] 读取运行时缓存失败:', error?.message || error);
    return { key: '' };
  }
}

function resolveAccountTypeMetadata(session, deps) {
  const fallbackType = session.cleanupProtected === true || session.storageType === 'custom' ? 'one_time' : '';
  const currentAccountType = firstText(
    deps.resolveCurrentAccountType(session.currentAccountType, session.currentAccountTypeLabel),
    fallbackType,
  );
  const generatedLabel = currentAccountType === 'one_time' && session.storageType === 'custom'
    ? '绑定账号'
    : deps.getCurrentAccountTypeLabel(currentAccountType);
  const permanent = currentAccountType === 'one_time'
    || (currentAccountType !== 'shared' && (
      session.cleanupProtected === true || session.storageType === 'custom' || deps.isPermanentAccountRecord(session)
    ));
  return {
    currentAccountType,
    currentAccountTypeLabel: firstText(session.currentAccountTypeLabel, generatedLabel).trim(),
    permanent,
  };
}

function resolveCleanupProtection(type, session) {
  if (type === 'one_time') return true;
  if (type === 'shared') return false;
  return session.cleanupProtected === true;
}

function buildAccountRecord(accountId, session, credentials, typeMetadata) {
  const { currentAccountType, currentAccountTypeLabel, permanent } = typeMetadata;
  const resolvedAccount = firstText(session.account, session.accountName).trim();
  return {
    id: accountId,
    key: firstText(session.key, credentials.key),
    deviceId: firstText(session.deviceId, credentials.deviceId),
    account: resolvedAccount,
    platform: firstText(session.platform).trim(),
    accountName: resolvedAccount,
    storageType: firstText(session.storageType, 'server'),
    storageGroup: firstText(session.storageGroup),
    storageGroupLabel: firstText(session.storageGroupLabel, permanent ? '绑定账号分组' : '临时账号分组'),
    cleanupProtected: resolveCleanupProtection(currentAccountType, session),
    currentAccountType,
    currentAccountTypeLabel,
    current_account_type: currentAccountType,
    current_account_type_label: currentAccountTypeLabel,
    cookies: session.cookies || [],
    browserStorage: session.browserStorage || [],
    lastUsedAt: session.lastUsedAt || null,
    serverRecycleTime: firstText(session.serverRecycleTime),
    serverRecycleTimeTs: session.serverRecycleTimeTs ?? null,
    serverRecycleTimeIso: firstText(session.serverRecycleTimeIso),
    currentPlatform: firstText(session.currentPlatform).trim(),
    currentUrl: firstText(session.currentUrl).trim(),
  };
}

function loadAccountRecord(accountId, deps = {}) {
  const {
    getCurrentAccountTypeLabel,
    getRuntimeLicenseCache,
    isPermanentAccountRecord,
    resolveCurrentAccountType,
    sessionStorage,
  } = deps;
  try {
    const session = sessionStorage.loadSession(accountId);
    if (!session) return null;
    const globalCredentials = readRuntimeCredentials(getRuntimeLicenseCache);
    const typeMetadata = resolveAccountTypeMetadata(session, {
      getCurrentAccountTypeLabel, isPermanentAccountRecord, resolveCurrentAccountType,
    });
    return buildAccountRecord(accountId, session, globalCredentials, typeMetadata);
  } catch (error) {
    console.error('[AccountStorage] 读取账号信息失败:', error?.message || error);
    return null;
  }
}

module.exports = { loadAccountRecord };
