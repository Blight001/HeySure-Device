const { firstText: readFirstText } = require('../../../shared/safe-values');

function firstText(...values) {
  return readFirstText(...values).trim();
}

function errorMessage(error, fallback = '') {
  return firstText(error && error.message, error, fallback);
}

function snapshotFrom(cache, fallback = {}) {
  if (!cache || typeof cache.getSnapshot !== 'function') return fallback;
  return cache.getSnapshot();
}

function resolveTarget(deps) {
  return deps.resolveConfiguredDreamTargetUrl(deps.getDreamTargetUrl, deps.DREAM_TARGET_URL);
}

async function resolveDeviceId(deps, preferredDeviceId = '') {
  const candidate = firstText(preferredDeviceId);
  if (candidate) return candidate;
  try {
    if (typeof deps.computeDeviceId !== 'function') return '';
    return firstText(await deps.computeDeviceId());
  } catch (error) {
    console.warn('[IPC] 计算设备号失败:', errorMessage(error));
    return '';
  }
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

function cleanupOptions(deps) {
  const sendToSide = deps.ui && typeof deps.ui.sendToSide === 'function'
    ? deps.ui.sendToSide
    : null;
  return {
    sendToSide,
    cleanupAccountArtifacts: (accountId) => cleanupAccountArtifacts(deps, accountId),
  };
}

function requireSessionImporter(deps) {
  const ui = deps.ui || {};
  const runtime = ui.browserRuntimeManager || {};
  if (typeof ui.addTab !== 'function' || typeof runtime.importSession !== 'function') {
    throw new Error('Chromium 会话注入能力不可用');
  }
  return { runtime, ui };
}

function accountBrowserName(account, accountId) {
  return firstText(
    account.currentPlatform,
    account.platform,
    account.accountName,
    account.account,
    accountId,
  );
}

async function injectAccountSession(deps, account, cookies, browserStorage, targetUrl) {
  const accountId = firstText(account && account.id);
  const resolvedTargetUrl = firstText(
    targetUrl,
    account && account.currentUrl,
    resolveTarget(deps),
  );
  if (!accountId || !resolvedTargetUrl) throw new Error('缺少账号 Profile 或目标地址');
  const { runtime, ui } = requireSessionImporter(deps);
  const browserName = accountBrowserName(account, accountId);
  const tabId = await ui.addTab(resolvedTargetUrl, {
    accountId,
    fixedTitle: browserName,
    tabTitle: browserName,
    deferChromiumNavigation: true,
  });
  if (!tabId) throw new Error('创建账号 Chromium Profile 失败');
  await runtime.importSession(tabId, {
    cookies: Array.isArray(cookies) ? cookies : [],
    browserStorage: Array.isArray(browserStorage) ? browserStorage : [],
    targetUrl: resolvedTargetUrl,
    navigateAfterImport: true,
  });
  await runtime.reload(tabId, 'chromium');
  deps.accountStorage.updateLastUsedTime(accountId);
  return tabId;
}

function runtimePlatformLabel(deps) {
  if (!deps.licenseCache || typeof deps.licenseCache.getRuntimeConfig !== 'function') return '';
  const config = deps.licenseCache.getRuntimeConfig();
  const direct = firstText(config && config.platformName);
  if (direct) return direct;
  const allowed = config && Array.isArray(config.allowedPlatforms) ? config.allowedPlatforms : [];
  return firstText(allowed[0]);
}

function currentPlatformLabel(deps) {
  try {
    if (typeof deps.getCurrentPlatformLabel === 'function') {
      const direct = firstText(deps.getCurrentPlatformLabel());
      if (direct) return direct;
    }
  } catch (_) {}
  try {
    return runtimePlatformLabel(deps) || '未知平台';
  } catch (_) {
    return '未知平台';
  }
}

function sendAccountListUpdated(deps) {
  try {
    if (deps.ui && typeof deps.ui.sendToSide === 'function') {
      deps.ui.sendToSide('account-list-updated', {});
    }
  } catch (_) {}
}

function createCredentialHandlers(deps) {
  return {
    async saveGlobalCredentials(_event, payload) {
      try {
        const { key, deviceId } = payload;
        if (!key) return { ok: false, error: '账号会话不能为空' };
        if (deps.licenseCache && typeof deps.licenseCache.setCredentials === 'function') {
          deps.licenseCache.setCredentials({ key, deviceId });
        }
        console.log('[IPC] 用户凭证保存成功（运行时缓存）');
        return { ok: true };
      } catch (error) {
        console.error('[IPC] 保存用户凭证失败（兼容模式）:', error);
        return { ok: false, error: errorMessage(error) };
      }
    },
    async getGlobalCredentials() {
      try {
        const snapshot = snapshotFrom(deps.licenseCache, { key: '', deviceId: '' });
        const deviceId = await resolveDeviceId(deps, snapshot.deviceId);
        return { ok: true, credentials: { key: snapshot.key || '', deviceId } };
      } catch (error) {
        console.error('[IPC] 获取用户凭证失败（兼容模式）:', error);
        return { ok: false, error: errorMessage(error) };
      }
    },
  };
}

function cookieResponse(fetchResult) {
  return {
    ok: true,
    cookies: fetchResult.cookies,
    serverRecycleTime: fetchResult.serverRecycleTime,
    serverRecycleTimeTs: fetchResult.serverRecycleTimeTs,
    serverRecycleTimeIso: fetchResult.serverRecycleTimeIso,
    server_recycle_time: fetchResult.serverRecycleTime,
    current_account_type: fetchResult.currentAccountType,
    current_account_type_label: fetchResult.currentAccountTypeLabel,
    currentAccountType: fetchResult.currentAccountType,
    currentAccountTypeLabel: fetchResult.currentAccountTypeLabel,
  };
}

async function fetchCookies(deps, _event, payload) {
  try {
    const deviceId = await resolveDeviceId(deps, payload.deviceId);
    if (!payload.key || !deviceId) return { ok: false, error: '缺少账号会话或设备号' };
    if (!deps.httpClient) {
      return { ok: false, degraded: true, error: '网络客户端不可用，无法获取账号信息，请重启应用' };
    }
    const result = await deps.auth.fetchCookieFromServerForDream(
      payload.key,
      deviceId,
      { consumeUsage: false },
    );
    return cookieResponse(result);
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function fetchedAccountMetadata(result) {
  return {
    accountType: {
      currentAccountType: result.currentAccountType,
      currentAccountTypeLabel: result.currentAccountTypeLabel,
      current_account_type: result.currentAccountType,
      current_account_type_label: result.currentAccountTypeLabel,
    },
    recycleTime: {
      serverRecycleTime: result.serverRecycleTime,
      serverRecycleTimeTs: result.serverRecycleTimeTs,
      serverRecycleTimeIso: result.serverRecycleTimeIso,
      server_recycle_time: result.serverRecycleTime,
      ai_account_expiry_time: result.serverRecycleTime,
      aiAccountExpiryTime: result.serverRecycleTime,
    },
  };
}

async function resolveSaveAccountData(deps, cookies, credentials) {
  if (Array.isArray(cookies) && cookies.length) {
    return { cookies, browserStorage: null, accountType: {}, recycleTime: {}, platform: '' };
  }
  console.log('[save-account] 从服务器获取 cookies...');
  const result = await deps.auth.fetchCookieFromServerForDream(credentials.key, credentials.deviceId);
  const metadata = fetchedAccountMetadata(result);
  return {
    cookies: result.cookies,
    browserStorage: Array.isArray(result.browserStorage) ? result.browserStorage : null,
    accountType: metadata.accountType,
    recycleTime: metadata.recycleTime,
    platform: result.platform || '',
  };
}

async function rollbackFailedAccount(deps, accountId) {
  const result = await cleanupAccountArtifacts(deps, accountId);
  if (result && result.ok) deps.accountStorage.deleteAccount(accountId);
}

async function saveAccount(deps, _event, payload) {
  try {
    const snapshot = snapshotFrom(deps.licenseCache, { key: '', deviceId: '' });
    const credentials = {
      key: snapshot.key || '',
      deviceId: await resolveDeviceId(deps, snapshot.deviceId),
    };
    if (!credentials.key || !credentials.deviceId) return { ok: false, error: '请先登录账号' };
    let data;
    try {
      data = await resolveSaveAccountData(deps, payload.cookies, credentials);
    } catch (error) {
      console.error('[save-account] 获取 cookies 失败，不保存账号:', errorMessage(error));
      return { ok: false, error: errorMessage(error, '无法获取账号信息，账号保存失败') };
    }
    if (!Array.isArray(data.cookies) || !data.cookies.length) {
      return { ok: false, error: '账号信息为空，无法保存账号' };
    }
    const result = deps.accountStorage.addAccount({
      cookies: data.cookies,
      browserStorage: Array.isArray(data.browserStorage) ? data.browserStorage : undefined,
      accountName: payload.accountName,
      platform: data.platform,
      currentUrl: resolveTarget(deps),
      ...data.accountType,
      ...data.recycleTime,
    });
    if (!result.ok) return result;
    try {
      await injectAccountSession(deps, result.account, data.cookies, data.browserStorage, result.account.currentUrl);
      deps.updateAccountRecycleTimer(deps.accountStorage, result.account, cleanupOptions(deps));
      return result;
    } catch (error) {
      await rollbackFailedAccount(deps, result.account.id);
      return { ok: false, error: errorMessage(error, '账号会话注入失败') };
    }
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function importSelectionOptions() {
  return {
    title: '导入账号',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Cookie 文件', extensions: ['json', 'txt', 'cookie', 'cookies', 'log'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  };
}

function readGlobalKey(deps) {
  try {
    return snapshotFrom(deps.licenseCache, { key: '' }).key || '';
  } catch (error) {
    console.warn('[IPC] 读取全局凭证失败:', errorMessage(error));
    return '';
  }
}

function importedAccountInput(context, descriptor) {
  const { imported, baseName } = descriptor;
  return {
    cookies: imported.cookies,
    browserStorage: imported.browserStorage,
    accountName: baseName,
    key: context.key,
    deviceId: context.deviceId,
    storageType: 'custom',
    storageGroup: baseName,
    storageGroupLabel: '绑定账号分组',
    cleanupProtected: true,
    currentAccountType: 'one_time',
    currentAccountTypeLabel: '绑定账号',
    platform: context.platform,
    currentPlatform: context.platformLabel,
    currentUrl: firstText(context.currentUrl, context.serverUrl, context.firstUrl, context.defaultUrl),
  };
}

function readImportDescriptor(deps, filePath, defaultUrl) {
  const content = deps.fs.readFileSync(filePath, 'utf8');
  const parsed = deps.parseImportedAccountContent(content, defaultUrl);
  const imported = {
    cookies: Array.isArray(parsed.cookies) ? parsed.cookies : [],
    browserStorage: Array.isArray(parsed.browserStorage) ? parsed.browserStorage : [],
  };
  return {
    imported,
    baseName: deps.path.basename(filePath, deps.path.extname(filePath)) || `导入账号${Date.now()}`,
  };
}

async function importOneFile(deps, context, filePath) {
  const descriptor = readImportDescriptor(deps, filePath, context.defaultUrl);
  if (!descriptor.imported.cookies.length && !descriptor.imported.browserStorage.length) {
    throw new Error('未识别到可导入的 Cookie 或 browserStorage 格式');
  }
  const result = deps.accountStorage.addAccount(importedAccountInput(context, descriptor));
  if (!result.ok) throw new Error(result.error || '导入失败');
  try {
    await injectAccountSession(
      deps,
      result.account,
      descriptor.imported.cookies,
      descriptor.imported.browserStorage,
      result.account.currentUrl,
    );
  } catch (error) {
    await rollbackFailedAccount(deps, result.account.id);
    throw new Error(errorMessage(error, 'Cookie 注入 Chromium 失败'));
  }
  deps.updateAccountRecycleTimer(deps.accountStorage, result.account, cleanupOptions(deps));
  return {
    filePath,
    account: result.account,
    importedCount: descriptor.imported.cookies.length,
    importedBrowserStorageCount: descriptor.imported.browserStorage.length,
  };
}

async function importFiles(deps, context, filePaths) {
  const results = [];
  const failures = [];
  for (const filePath of Array.from(new Set(filePaths))) {
    try {
      results.push(await importOneFile(deps, context, filePath));
    } catch (error) {
      failures.push({ filePath, error: errorMessage(error) });
    }
  }
  return { results, failures };
}

function importSummary(results, failures) {
  const importedFiles = results.length;
  const importedCookies = results.reduce((sum, item) => sum + Number(item.importedCount || 0), 0);
  const importedBrowserStorage = results.reduce(
    (sum, item) => sum + Number(item.importedBrowserStorageCount || 0),
    0,
  );
  const failedFiles = failures.length;
  const details = `${importedFiles} 个文件，${importedCookies} 条 Cookie，${importedBrowserStorage} 组浏览器存储`;
  const message = failedFiles
    ? `已导入 ${details}，失败 ${failedFiles} 个文件`
    : `已批量导入 ${details}`;
  return { importedFiles, importedCookies, failedFiles, message };
}

async function buildImportContext(deps, selection) {
  const defaultUrl = resolveTarget(deps);
  const serverUrl = firstText(resolveTarget(deps), defaultUrl);
  const content = deps.fs.readFileSync(selection.filePaths[0], 'utf8');
  const parsed = deps.parseImportedAccountContent(content, defaultUrl);
  const firstUrl = deps.inferImportedTargetUrl(parsed, defaultUrl);
  const label = currentPlatformLabel(deps);
  const decision = await deps.showImportedPlatformPrompt({
    ipcMain: deps.ipcMain,
    ui: deps.ui,
    platformLabel: label,
    targetUrl: serverUrl,
  });
  if (decision.cancelled) return null;
  return {
    key: readGlobalKey(deps),
    deviceId: await resolveDeviceId(deps),
    defaultUrl,
    serverUrl,
    firstUrl,
    platform: decision.confirmed ? label : '未知平台',
    platformLabel: decision.confirmed ? label : '未知平台',
    currentUrl: decision.confirmed ? serverUrl : '',
  };
}

async function importCookieFile(deps) {
  try {
    if (!deps.dialog || typeof deps.dialog.showOpenDialog !== 'function') {
      return { ok: false, error: '当前环境不支持文件选择' };
    }
    const selection = await deps.dialog.showOpenDialog(importSelectionOptions());
    if (selection.canceled || !Array.isArray(selection.filePaths) || !selection.filePaths[0]) {
      return { ok: false, cancelled: true, error: '已取消导入' };
    }
    const context = await buildImportContext(deps, selection);
    if (!context) return { ok: false, cancelled: true, error: '已取消导入' };
    const { results, failures } = await importFiles(deps, context, selection.filePaths);
    if (!results.length) return { ok: false, error: failures[0] && failures[0].error || '没有成功导入任何 Cookie' };
    sendAccountListUpdated(deps);
    return { ok: true, results, failures, ...importSummary(results, failures) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function deleteOneAccount(deps, accountId) {
  const cleanup = await cleanupAccountArtifacts(deps, accountId);
  if (!cleanup || !cleanup.ok) {
    return { accountId, error: cleanup && cleanup.error || '清理浏览器记录失败' };
  }
  const result = deps.accountStorage.deleteAccount(accountId);
  return result && result.ok
    ? null
    : { accountId, error: result && result.error || '删除失败' };
}

async function deleteAccounts(deps, _event, payload) {
  try {
    const source = Array.isArray(payload.accountIds) ? payload.accountIds : [];
    const ids = Array.from(new Set(source.map((id) => firstText(id)).filter(Boolean)));
    if (!ids.length) return { ok: false, error: '缺少账号ID' };
    const failed = [];
    let removedCount = 0;
    for (const accountId of ids) {
      const failure = await deleteOneAccount(deps, accountId);
      if (failure) failed.push(failure);
      else removedCount += 1;
    }
    sendAccountListUpdated(deps);
    if (failed.length) {
      const error = failed.length === 1 ? `删除失败：${failed[0].accountId}` : `有 ${failed.length} 个账号删除失败`;
      return { ok: false, error, removedCount, failed };
    }
    const message = removedCount === 1 ? '账号已删除' : `已删除 ${removedCount} 个账号`;
    return { ok: true, removedCount, message };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function readAccountProfile(deps, accountId) {
  const ui = deps.ui || {};
  const runtime = ui.browserRuntimeManager || {};
  const store = runtime.store || {};
  return typeof store.readProfile === 'function' ? store.readProfile(accountId) : null;
}

function switchTarget(deps, account) {
  const serverUrl = firstText(resolveTarget(deps));
  const savedUrl = firstText(account.currentUrl);
  return (!deps.isPlaceholderTargetUrl(savedUrl) ? savedUrl : serverUrl) || 'about:blank';
}

async function switchAccount(deps, _event, payload) {
  try {
    const accountId = firstText(payload.accountId);
    if (!accountId) return { ok: false, error: '缺少账号ID' };
    const accountResult = deps.accountStorage.getAccount(accountId);
    if (!accountResult.ok || !accountResult.account) return { ok: false, error: '账号不存在' };
    const profile = readAccountProfile(deps, accountId);
    if (!profile || !profile.createdAt) return { ok: false, error: '账号浏览器环境不存在，请重新获取或导入账号' };
    const ui = deps.ui || {};
    if (typeof ui.addTab !== 'function') throw new Error('打开账号失败：标签页能力不可用');
    const account = accountResult.account;
    const browserName = firstText(
      account.currentPlatform,
      account.platform,
      account.accountName,
      account.displayName,
      currentPlatformLabel(deps),
      accountId,
    );
    const tabId = await ui.addTab(switchTarget(deps, account), {
      accountId,
      fixedTitle: browserName,
      tabTitle: browserName,
      restoreLastSession: true,
    });
    if (!tabId) throw new Error('账号对应的浏览器打开失败');
    deps.accountStorage.updateLastUsedTime(accountId);
    sendAccountListUpdated(deps);
    return { ok: true, tabId, accountId };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function createAccountRememberHandlers(deps) {
  const credentials = createCredentialHandlers(deps);
  return {
    ...credentials,
    fetchCookies: (event, payload) => fetchCookies(deps, event, payload),
    saveAccount: (event, payload) => saveAccount(deps, event, payload),
    importCookieFile: () => importCookieFile(deps),
    async getAllAccounts() {
      try {
        return { ok: true, accounts: deps.accountStorage.getAllAccounts() };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
    deleteAccounts: (event, payload) => deleteAccounts(deps, event, payload),
    switchAccount: (event, payload) => switchAccount(deps, event, payload),
  };
}

module.exports = { createAccountRememberHandlers };
