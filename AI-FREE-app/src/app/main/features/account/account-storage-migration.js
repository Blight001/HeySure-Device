'use strict';

const { firstText } = require('../../../shared/safe-values');

const ACCOUNT_COOKIE_NAMES = [
  'username', 'user_name', 'userName', 'user-name',
  'email', 'user_email', 'userEmail', 'user-email',
  'account', 'account_name', 'accountName', 'account-name',
  'name', 'display_name', 'displayName', 'display-name',
  'nickname', 'nick_name', 'nickName', 'nick-name',
  'user', 'user_id', 'userId', 'user-id',
];

function extractAccountNameFromCookies(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) return null;
  for (const cookieName of ACCOUNT_COOKIE_NAMES) {
    const cookie = cookies.find((item) => String(item?.name || '').toLowerCase() === cookieName.toLowerCase());
    if (cookie?.value) return cookie.value;
  }
  for (const cookie of cookies) {
    if (!cookie?.value) continue;
    try {
      const parsed = JSON.parse(cookie.value);
      if (!parsed || typeof parsed !== 'object') continue;
      for (const key of ACCOUNT_COOKIE_NAMES) {
        if (typeof parsed[key] === 'string' && parsed[key]) return parsed[key];
      }
    } catch (_) {}
  }
  return null;
}

function isMigratableLegacyAccount(account) {
  return Boolean(account && account.id && account.key && account.deviceId);
}

function migrateLegacyCredentials(getRuntimeLicenseCache, account) {
  const licenseCache = getRuntimeLicenseCache();
  if (!licenseCache || typeof licenseCache.setCredentials !== 'function') return false;
  licenseCache.setCredentials({ key: account.key, deviceId: account.deviceId });
  return true;
}

function migrateFromOldStorage(deps = {}) {
  const { fs, path, getCoreDir, getRuntimeLicenseCache, sessionStorage } = deps;
  try {
    const oldAccountsFile = path.join(getCoreDir(), 'saved_accounts.json');
    if (!fs.existsSync(oldAccountsFile)) return 0;
    console.log('[AccountStorage] 发现旧的账号文件，正在迁移数据到新的 store/content 存储结构...');
    const oldAccounts = JSON.parse(fs.readFileSync(oldAccountsFile, 'utf8'));
    if (!Array.isArray(oldAccounts) || oldAccounts.length === 0) return 0;
    let migratedCount = 0;
    let credentialsMigrated = false;
    for (const oldAccount of oldAccounts) {
      if (!isMigratableLegacyAccount(oldAccount)) continue;
      if (!credentialsMigrated) {
        credentialsMigrated = migrateLegacyCredentials(getRuntimeLicenseCache, oldAccount);
        if (!credentialsMigrated) continue;
      }
      if (sessionStorage.saveSession(oldAccount.id, { storageType: 'server', cleanupProtected: false })) {
        migratedCount += 1;
      }
    }
    if (migratedCount > 0) {
      const backupPath = `${oldAccountsFile}.backup`;
      fs.copyFileSync(oldAccountsFile, backupPath);
      fs.unlinkSync(oldAccountsFile);
      console.log(`[AccountStorage] 成功迁移 ${migratedCount} 个账号，备份:`, backupPath);
    }
    return migratedCount;
  } catch (error) {
    console.error('[AccountStorage] 迁移旧数据失败:', firstText(error && error.message, error));
    return 0;
  }
}

module.exports = { extractAccountNameFromCookies, migrateFromOldStorage };
