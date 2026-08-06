function resolveDreamTargetUrl(getDreamTargetUrl, fallbackUrl = '') {
  try {
    if (typeof getDreamTargetUrl === 'function') {
      const value = getDreamTargetUrl();
      if (value && typeof value === 'string') return value;
    }
  } catch (_) {}
  return fallbackUrl;
}

function getAccountTypeInfo(account) {
  if (!account || typeof account !== 'object') {
    return { type: '', label: '' };
  }
  return {
    type: String(
      account.currentAccountType
      || account.current_account_type
      || account.accountType
      || account.account_type
      || ''
    ).trim(),
    label: String(
      account.currentAccountTypeLabel
      || account.current_account_type_label
      || account.accountTypeLabel
      || account.account_type_label
      || ''
    ).trim(),
  };
}

function isPermanentAccountRecord(account, options = {}) {
  if (!account || typeof account !== 'object') return false;
  const includeProtected = options.includeProtected === true;
  if (includeProtected) {
    const storageType = String(account.storageType || account.storage_type || '').trim();
    if (storageType === 'custom' || account.cleanupProtected === true) {
      return true;
    }
  }

  const { type, label } = getAccountTypeInfo(account);
  return type === 'one_time' || label.includes('永久') || label.includes('长久');
}

function loadAccountRecord(accountStorage, accountId) {
  if (!accountId || typeof accountStorage.getAccount !== 'function') return null;
  const result = accountStorage.getAccount(accountId);
  return result?.ok === true && result.account ? result.account : null;
}

function listAccountRecords(accountStorage) {
  if (typeof accountStorage.getAllAccounts !== 'function') return [];
  const summaries = accountStorage.getAllAccounts();
  return Array.isArray(summaries) ? summaries : [];
}

function findLoadedAccount(accountStorage, predicate) {
  for (const summary of listAccountRecords(accountStorage)) {
    const account = loadAccountRecord(accountStorage, String(summary?.id || '').trim());
    if (account && predicate(account)) return account;
  }
  return null;
}

function findAccountRecord(accountStorage, options = {}) {
  if (!accountStorage) return null;
  const normalizedAccountId = String(options.accountId || '').trim();
  const normalizedKey = String(options.key || '').trim();

  try {
    const account = loadAccountRecord(accountStorage, normalizedAccountId);
    if (account) return account;
    if (!normalizedKey) return null;
    return findLoadedAccount(accountStorage, (item) => String(item.key || '').trim() === normalizedKey);
  } catch (_) {
    return null;
  }
}

function findPermanentAccountByKey(accountStorage, key, options = {}) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey || !accountStorage) return null;

  try {
    return findLoadedAccount(accountStorage, (account) => (
      String(account.key || '').trim() === normalizedKey && isPermanentAccountRecord(account, options)
    ));
  } catch (error) {
    const logger = options.logger;
    if (logger && typeof logger.warn === 'function') {
      logger.warn('[IPC] 查找绑定账号失败:', error?.message || error);
    }
  }

  return null;
}

module.exports = {
  findAccountRecord,
  findPermanentAccountByKey,
  isPermanentAccountRecord,
  resolveDreamTargetUrl,
};
