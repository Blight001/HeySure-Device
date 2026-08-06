'use strict';

class ExtensionWatcher {
  constructor(deps = {}) {
    this.deps = /** @type {Record<string, any>} */ ({ logger: console, ...deps });
    this.realtimeStarted = false;
    this.refreshTimer = null;
    this.refreshDebounceTimer = null;
    this.refreshInFlight = null;
    this.refreshQueued = false;
    this.watcherRootsKey = '';
    this.extensionWatchers = [];
  }

  closeExtensionWatchers() {
    for (const watcher of this.extensionWatchers) {
      try { watcher.close(); } catch (_) {}
    }
    this.extensionWatchers = [];
    this.watcherRootsKey = '';
  }

  shouldWatchEvent(filename) {
    const lower = String(filename || '').toLowerCase();
    if (!lower || lower.endsWith('manifest.json')) return true;
    const ext = this.deps.path.extname(lower);
    return !ext || ['.js', '.mjs', '.cjs', '.html', '.htm', '.json'].includes(ext);
  }

  createWatcher(root, recursive) {
    const options = recursive ? { recursive: true } : undefined;
    return this.deps.fs.watch(root, options, (_eventType, filename) => {
      if (!this.shouldWatchEvent(filename)) return;
      this.scheduleRealtimeRefresh(`目录变化 ${this.deps.path.basename(root)}`);
    });
  }

  watchRoot(root) {
    const normalized = String(root || '').replace(/\\/g, '/').toLowerCase();
    if (normalized.includes('.asar/') && !normalized.includes('.asar.unpacked/')) return null;
    try {
      return this.createWatcher(root, true);
    } catch (error) {
      try {
        return this.createWatcher(root, false);
      } catch (fallbackError) {
        this.deps.logger.warn?.('[Extensions] 监听插件目录失败:', root, fallbackError?.message || error?.message || fallbackError);
        return null;
      }
    }
  }

  setupExtensionWatchers() {
    const roots = this.deps.resolveBundledExtensionRoots();
    const rootsKey = roots.join('|');
    if (rootsKey === this.watcherRootsKey) return;
    this.closeExtensionWatchers();
    this.watcherRootsKey = rootsKey;
    this.extensionWatchers = roots.map((root) => this.watchRoot(root)).filter(Boolean);
  }

  scheduleRealtimeRefresh(reason = '目录变化') {
    if (this.refreshDebounceTimer) clearTimeout(this.refreshDebounceTimer);
    this.refreshDebounceTimer = setTimeout(() => {
      this.refreshDebounceTimer = null;
      void this.runRealtimeRefresh(reason);
    }, this.deps.refreshDebounceMs);
    this.refreshDebounceTimer.unref?.();
  }

  async performRealtimeRefresh(reason) {
    this.setupExtensionWatchers();
    await this.deps.refreshBundledExtensions({ reason });
    await this.deps.ensureEnabledPluginsLoadedInCurrentSessions(reason);
  }

  async runRealtimeRefresh(reason = '定时巡检') {
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return this.refreshInFlight;
    }
    this.refreshInFlight = this.performRealtimeRefresh(reason);
    try {
      return await this.refreshInFlight;
    } catch (error) {
      this.deps.logger.warn?.('[Extensions] 实时刷新插件失败:', error?.message || error);
      return null;
    } finally {
      this.finishRealtimeRefresh();
    }
  }

  finishRealtimeRefresh() {
    this.refreshInFlight = null;
    if (!this.refreshQueued) return;
    this.refreshQueued = false;
    this.scheduleRealtimeRefresh('队列刷新');
  }

  stopRealtimePluginLoading() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.refreshDebounceTimer) clearTimeout(this.refreshDebounceTimer);
    this.refreshTimer = null;
    this.refreshDebounceTimer = null;
    this.closeExtensionWatchers();
    this.realtimeStarted = false;
  }

  startRealtimePluginLoading() {
    if (this.realtimeStarted) return;
    this.realtimeStarted = true;
    this.setupExtensionWatchers();
    this.refreshTimer = setInterval(() => void this.runRealtimeRefresh('定时巡检'), this.deps.refreshIntervalMs);
    this.refreshTimer.unref?.();
    try {
      this.deps.app?.once?.('before-quit', () => this.stopRealtimePluginLoading());
    } catch (_) {}
  }
}

function createExtensionWatcher(deps) {
  const watcher = new ExtensionWatcher(deps);
  return {
    closeExtensionWatchers: watcher.closeExtensionWatchers.bind(watcher),
    shouldWatchEvent: watcher.shouldWatchEvent.bind(watcher),
    setupExtensionWatchers: watcher.setupExtensionWatchers.bind(watcher),
    scheduleRealtimeRefresh: watcher.scheduleRealtimeRefresh.bind(watcher),
    runRealtimeRefresh: watcher.runRealtimeRefresh.bind(watcher),
    stopRealtimePluginLoading: watcher.stopRealtimePluginLoading.bind(watcher),
    startRealtimePluginLoading: watcher.startRealtimePluginLoading.bind(watcher),
  };
}

module.exports = { createExtensionWatcher };
