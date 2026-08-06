const {
  buildManagedTabPartitionName,
  normalizePersistPartitionName,
} = require('./tab-common');
const { removeDirectoryWithRetries: removeDirWithRetries } = require('../utils/fs-cleanup');

function isManagedTabPartitionName(partitionName) {
  return String(partitionName || '').trim().startsWith('tab-');
}

function isEphemeralManagedTabPartitionName(partitionName) {
  return /^tab-\d+$/.test(String(partitionName || '').trim());
}

// AI-FREE 网页已迁移到独立 Chromium Profile；旧 Electron Partitions 可统一回收。
function isPersistentManagedTabPartitionName(_partitionName) {
  return false;
}

function isPersistentSharedPartitionName(_partitionName) {
  return false;
}

function windowUsesSession(win, session) {
  try {
    const contents = win?.webContents;
    return Boolean(win && !win.isDestroyed() && contents && !contents.isDestroyed() && contents.session === session);
  } catch (_) {
    return false;
  }
}

function createSessionUserChecker(deps) {
  return function hasLiveBrowserUsersForSession(session, partitionName, excludedTabId = null) {
    const normalizedName = normalizePersistPartitionName(partitionName);
    if (!session || !normalizedName) return false;
    for (const [tabId, tab] of deps.getTabs().entries()) {
      if (excludedTabId && tabId === excludedTabId) continue;
      if (normalizePersistPartitionName(tab?.partition) === normalizedName) return true;
    }
    for (const win of deps.BrowserWindow.getAllWindows()) {
      if (windowUsesSession(win, session)) return true;
    }
    return false;
  };
}

function createDirectoryTools(deps) {
  const getBrowserPartitionsRootDir = () => deps.path.join(deps.app.getPath('userData'), 'Partitions');
  const removeDirectoryWithRetries = (dirPath, label = '目录') => removeDirWithRetries(deps.fs, dirPath, {
    logger: deps.logger,
    failureMessage: `[缓存清理] 删除${label}失败:`,
  });
  return { getBrowserPartitionsRootDir, removeDirectoryWithRetries };
}

async function clearSessionCache(session, partitionName, logger) {
  try {
    await session.clearCache();
    logger.log?.(`[缓存清理] 已清理会话缓存: ${partitionName || 'default-session'}`);
  } catch (error) {
    logger.warn?.('[缓存清理] 清理会话缓存失败:', partitionName || 'default-session', error?.message || error);
  }
}

function createSessionCleanup(deps, hasLiveBrowserUsersForSession) {
  /** @param {Record<string, any>} [options] */
  return async function cleanupBrowserSessionData(options = {}) {
    const { partition, session, excludedTabId = null, source = '浏览器', force = false } = options;
    const partitionName = normalizePersistPartitionName(partition);
    if (!session) return { ok: false, skipped: true };
    const managed = Boolean(partitionName) && isManagedTabPartitionName(partitionName);
    const exiting = String(source || '').includes('退出');
    if (managed && !force && !exiting && hasLiveBrowserUsersForSession(session, partitionName, excludedTabId)) {
      deps.logger.log?.(`[缓存清理] ${source} 分区仍在使用，跳过:`, partitionName);
      return { ok: true, skipped: true, reason: 'in-use' };
    }
    await clearSessionCache(session, partitionName, deps.logger);
    if (!managed) return { ok: true, removed: false, skipped: false };
    return { ok: true, removed: false, skipped: true, reason: 'persistent-tab-partition' };
  };
}

async function clearSessionStorage(session, partitionName, logger) {
  try {
    if (session && typeof session.clearStorageData === 'function') await session.clearStorageData();
  } catch (error) {
    logger.warn?.('[缓存清理] 清理会话存储失败:', partitionName, error?.message || error);
  }
}

function createSessionPurge(deps, directoryTools) {
  /** @param {Record<string, any>} [options] */
  return async function purgeBrowserSessionData(options = {}) {
    const { partition, session, source = '账号删除' } = options;
    const partitionName = normalizePersistPartitionName(partition);
    if (!partitionName) return { ok: false, skipped: true, reason: 'missing-partition' };
    await clearSessionStorage(session, partitionName, deps.logger);
    if (session && typeof session.clearCache === 'function') {
      await clearSessionCache(session, partitionName, deps.logger);
    }
    const partitionDir = deps.path.join(directoryTools.getBrowserPartitionsRootDir(), partitionName);
    const removed = await directoryTools.removeDirectoryWithRetries(partitionDir, `Partitions/${partitionName}`);
    deps.logger.log?.(`[缓存清理] ${source} 已删除分区数据:`, partitionName, removed);
    return { ok: true, removed, partition: partitionName };
  };
}

function createCleanupTargetCollector(deps) {
  return function collectBrowserSessionCleanupTargets() {
    const targets = [];
    const seen = new Set();
    const push = (session, partition, source) => {
      if (!session || seen.has(session)) return;
      seen.add(session);
      targets.push({ session, partition, source });
    };
    const tabs = deps.getTabs();
    push(deps.getSideView()?.webContents?.session, undefined, '侧边栏');
    push(deps.getMainWindow()?.webContents?.session, undefined, '主窗口');
    push(deps.getLicenseWindow()?.webContents?.session, undefined, '验证窗口');
    push(deps.getExtPopupWin()?.webContents?.session, tabs.get(deps.getActiveTabId())?.partition, '扩展弹窗');
    push(deps.electronSession?.defaultSession, undefined, '默认会话');
    return targets;
  };
}

function createCleanupAll(deps, collectTargets, cleanupSession) {
  return async function cleanupAllBrowserSessionData({ source = '退出', force = false } = {}) {
    const targets = collectTargets();
    if (!targets.length) return { ok: true, cleanedCount: 0, skipped: true };
    let cleanedCount = 0;
    for (const target of targets) {
      try {
        const result = await cleanupSession({ ...target, source, excludedTabId: null, force });
        if (result?.ok) cleanedCount += 1;
      } catch (error) {
        deps.logger.warn?.('[缓存清理] 退出时清理会话失败:', target?.source || '未知会话', error?.message || error);
      }
    }
    return { ok: true, cleanedCount, targetCount: targets.length };
  };
}

async function removePartitionEntries(deps, directoryTools, rootDir) {
  const result = { cleanedCount: 0, failedCount: 0, keptPersistentCount: 0 };
  try {
    const entries = await deps.fs.promises.readdir(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (isPersistentSharedPartitionName(entry.name) || isPersistentManagedTabPartitionName(entry.name)) {
        result.keptPersistentCount += 1;
        continue;
      }
      try {
        const entryPath = deps.path.join(rootDir, entry.name);
        const removed = await directoryTools.removeDirectoryWithRetries(entryPath, `Partitions/${entry.name}`);
        if (removed) result.cleanedCount += 1;
        else result.failedCount += 1;
      } catch (error) {
        result.failedCount += 1;
        deps.logger.warn?.('[退出] 逐个清理 Partitions 子项失败:', entry.name, error?.message || error);
      }
    }
  } catch (error) {
    deps.logger.warn?.('[退出] 枚举 Partitions 子项失败:', error?.message || error);
  }
  return result;
}

async function removeEmptyPartitionsRoot(deps, rootDir, result) {
  if (result.failedCount) return false;
  try {
    await deps.fs.promises.rm(rootDir, { recursive: true, force: true });
    return !deps.fs.existsSync(rootDir);
  } catch (error) {
    result.failedCount += 1;
    deps.logger.warn?.('[退出] 删除旧 Partitions 根目录失败:', error?.message || error);
    return false;
  }
}

function createPartitionsRootCleanup(deps, directoryTools) {
  return async function cleanupBrowserPartitionsRootDir() {
    const rootDir = directoryTools.getBrowserPartitionsRootDir();
    if (!deps.fs.existsSync(rootDir)) {
      return { ok: true, removed: false, cleanedCount: 0, partitionsRootDir: rootDir };
    }
    const result = await removePartitionEntries(deps, directoryTools, rootDir);
    const removed = await removeEmptyPartitionsRoot(deps, rootDir, result);
    return { ok: true, removed, ...result, partitionsRootDir: rootDir };
  };
}

function createBrowserPartitionCleaner(input = {}) {
  const deps = {
    getTabs: () => new Map(),
    getMainWindow: () => null,
    getSideView: () => null,
    getLicenseWindow: () => null,
    getActiveTabId: () => null,
    getExtPopupWin: () => null,
    logger: console,
    ...input,
  };
  const directoryTools = createDirectoryTools(deps);
  const hasLiveBrowserUsersForSession = createSessionUserChecker(deps);
  const cleanupBrowserSessionData = createSessionCleanup(deps, hasLiveBrowserUsersForSession);
  const purgeBrowserSessionData = createSessionPurge(deps, directoryTools);
  const collectBrowserSessionCleanupTargets = createCleanupTargetCollector(deps);
  return {
    normalizePersistPartitionName,
    isManagedTabPartitionName,
    isEphemeralManagedTabPartitionName,
    isPersistentManagedTabPartitionName,
    buildManagedTabPartitionName,
    isPersistentSharedPartitionName,
    hasLiveBrowserUsersForSession,
    ...directoryTools,
    cleanupBrowserSessionData,
    purgeBrowserSessionData,
    collectBrowserSessionCleanupTargets,
    cleanupAllBrowserSessionData: createCleanupAll(deps, collectBrowserSessionCleanupTargets, cleanupBrowserSessionData),
    cleanupBrowserPartitionsRootDir: createPartitionsRootCleanup(deps, directoryTools),
  };
}

module.exports = { createBrowserPartitionCleaner };
