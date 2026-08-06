const crypto = require('crypto');
const { createExtensionFileUtils } = require('../features/extensions/extension-file-utils');
const { createExtensionCompatService } = require('../features/extensions/extension-compat-service');
const { createExtensionDiscoveryService } = require('../features/extensions/extension-discovery-service');
const { createExtensionSessionController } = require('../features/extensions/extension-session-controller');
const { createExtensionWatcher } = require('../features/extensions/extension-watcher');
const { createExtensionMutationService } = require('../features/extensions/extension-mutation-service');
const config = require('../features/extensions/extension-config');
const { readJsonFileSafe, readStoreConfigFile, writeStoreConfigFile } = require('../utils/json-store');

function createManagerFileUtils(runtime) {
  const { app, fs, path } = runtime.deps;
  return createExtensionFileUtils({ app, fs, path, compatCacheDirName: config.COMPAT_CACHE_DIR_NAME });
}

function createManagerCompatService(runtime) {
  const { fs, logger, path } = runtime.deps;
  const files = runtime.files;
  return createExtensionCompatService({
    compatCacheSchema: config.COMPAT_CACHE_SCHEMA,
    compatShimFile: config.COMPAT_SHIM_FILE,
    compatShimMarker: config.COMPAT_SHIM_MARKER,
    copyDirectoryRecursive: files.copyDirectoryRecursive,
    fs,
    hashId: runtime.hashId.bind(runtime),
    isPathInside: files.isPathInside,
    listExtensionTextFiles: files.listExtensionTextFiles,
    logger,
    normalizeAbsolutePath: runtime.normalizeAbsolutePath.bind(runtime),
    path,
    readJsonFile: runtime.readJsonFile.bind(runtime),
    resolveCompatCacheRoot: files.resolveCompatCacheRoot,
    sanitizeManifestPermissionsForElectron: config.sanitizeManifestPermissionsForElectron,
    scanExtensionCompatNeeds: files.scanExtensionCompatNeeds,
    toSafeFileName: files.toSafeFileName,
  });
}

function createManagerDiscovery(runtime) {
  const { app, fs, getTranslateExtDir, logger, path } = runtime.deps;
  return createExtensionDiscoveryService({
    app,
    builtinRemoveWatermarkId: config.BUILTIN_REMOVE_WATERMARK_ID,
    builtinTranslateId: config.BUILTIN_TRANSLATE_ID,
    fs,
    getTranslateExtDir,
    hashId: runtime.hashId.bind(runtime),
    listExtensionTextFiles: runtime.files.listExtensionTextFiles,
    logger,
    normalizeAbsolutePath: runtime.normalizeAbsolutePath.bind(runtime),
    path,
    readJsonFile: runtime.readJsonFile.bind(runtime),
    sanitizeManifestPermissionsForElectron: config.sanitizeManifestPermissionsForElectron,
  });
}

function createManagerSessions(runtime) {
  const { app, fs, getActiveTabId, getTabs, logger, path } = runtime.deps;
  return createExtensionSessionController({
    app, fs, getActiveTabId, getTabs, logger, path,
    getState: () => runtime.state,
    normalizeAbsolutePath: runtime.normalizeAbsolutePath.bind(runtime),
    prepareCompatExtensionPath: runtime.compat.prepareCompatExtensionPath,
  });
}

function createManagerWatcher(runtime) {
  const { app, fs, logger, path } = runtime.deps;
  return createExtensionWatcher({
    app, fs, logger, path,
    ensureEnabledPluginsLoadedInCurrentSessions: runtime.sessions.ensureEnabledPluginsLoadedInCurrentSessions,
    refreshBundledExtensions: runtime.refreshBundledExtensions.bind(runtime),
    refreshDebounceMs: config.EXTENSION_REFRESH_DEBOUNCE_MS,
    refreshIntervalMs: config.EXTENSION_REFRESH_INTERVAL_MS,
    resolveBundledExtensionRoots: runtime.discovery.resolveBundledExtensionRoots,
  });
}

function createManagerMutations(runtime) {
  const { logger, onPluginStateChanged } = runtime.deps;
  return createExtensionMutationService({
    logger, onPluginStateChanged,
    buildPluginRecord: runtime.discovery.buildPluginRecord,
    emitStateChanged: runtime.emitStateChanged.bind(runtime),
    getPluginById: runtime.sessions.getPluginById,
    getPublicState: runtime.sessions.getPublicState,
    getState: () => runtime.state,
    hashId: runtime.hashId.bind(runtime),
    loadPluginIntoAllCurrentSessions: runtime.sessions.loadPluginIntoAllCurrentSessions,
    normalizeAbsolutePath: runtime.normalizeAbsolutePath.bind(runtime),
    persistState: runtime.persistState.bind(runtime),
    readManifest: runtime.discovery.readManifest,
    syncLegacyTranslateSetting: runtime.syncLegacyTranslateSetting.bind(runtime),
    toPublicPlugin: runtime.sessions.toPublicPlugin,
    unloadPluginFromAllSessions: runtime.sessions.unloadPluginFromAllSessions,
  });
}

class ExtensionManagerRuntime {
  constructor(deps = {}) {
    this.deps = /** @type {Record<string, any>} */ ({
      logger: console, getTabs: () => new Map(), getActiveTabId: () => null,
      applyPluginSettings: null, sendToSide: null, onPluginStateChanged: null,
      ...deps,
    });
    this.state = { developerModeEnabled: true, plugins: [] };
    this.files = createManagerFileUtils(this);
    this.compat = createManagerCompatService(this);
    this.discovery = createManagerDiscovery(this);
    this.sessions = createManagerSessions(this);
    this.watcher = createManagerWatcher(this);
    this.mutations = createManagerMutations(this);
  }

  normalizeAbsolutePath(value) {
    try {
      const raw = String(value || '').trim();
      return raw ? this.deps.path.resolve(raw) : '';
    } catch (_) { return ''; }
  }

  hashId(value) {
    return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 16);
  }

  readJsonFile(filePath) {
    return readJsonFileSafe(filePath, {
      fs: this.deps.fs, fallback: null, logger: this.deps.logger, logPrefix: 'Extensions',
    });
  }

  readStoreSafe() {
    return readStoreConfigFile(this.deps.getStorePath, { fs: this.deps.fs });
  }

  writeStoreSafe(nextStore) {
    return writeStoreConfigFile(this.deps.getStorePath, nextStore, {
      fs: this.deps.fs, path: this.deps.path, logger: this.deps.logger,
      logPrefix: 'Extensions', writeErrorMessage: '保存插件配置失败:',
    });
  }

  toStoredPlugin(plugin) {
    return {
      id: plugin.id, path: plugin.path, name: plugin.name, rawName: plugin.rawName,
      description: plugin.description, version: plugin.version, manifestVersion: plugin.manifestVersion,
      enabled: plugin.enabled === true, builtin: plugin.builtin === true,
      iconPath: plugin.iconPath, iconRelativePath: plugin.iconRelativePath,
      popupPath: plugin.popupPath, optionsPath: plugin.optionsPath, hint: plugin.hint,
      importedAt: plugin.importedAt, updatedAt: plugin.updatedAt,
    };
  }

  persistState() {
    const current = this.readStoreSafe();
    return this.writeStoreSafe({
      ...(current && typeof current === 'object' ? current : {}),
      [config.STORE_FIELD]: {
        developerModeEnabled: true,
        plugins: this.state.plugins.map((plugin) => this.toStoredPlugin(plugin)),
      },
    });
  }

  readStoredState() {
    const store = this.readStoreSafe();
    const manager = store && typeof store[config.STORE_FIELD] === 'object' ? store[config.STORE_FIELD] : {};
    return { developerModeEnabled: true, plugins: Array.isArray(manager.plugins) ? manager.plugins : [] };
  }

  syncLegacyTranslateSetting() {
    const plugin = this.state.plugins.find((item) => item.id === config.BUILTIN_TRANSLATE_ID);
    if (typeof this.deps.applyPluginSettings !== 'function') return;
    try {
      this.deps.applyPluginSettings({ translateExtEnabled: plugin?.enabled === true });
    } catch (error) {
      this.deps.logger.warn?.('[Extensions] 同步翻译插件开关失败:', error?.message || error);
    }
  }

  emitStateChanged() {
    try {
      if (typeof this.deps.sendToSide === 'function') {
        this.deps.sendToSide('extension-manager-state', this.sessions.getPublicState());
      }
    } catch (_) {}
  }

  getPluginMaps(plugins = []) {
    const byId = new Map();
    const byPath = new Map();
    for (const plugin of plugins) {
      if (!plugin || !plugin.id) continue;
      byId.set(plugin.id, plugin);
      const normalizedPath = this.normalizeAbsolutePath(plugin.path);
      if (normalizedPath) byPath.set(normalizedPath, plugin);
    }
    return { byId, byPath };
  }

  resolveExistingBundledPlugin(id, dir, currentMaps, storedMaps) {
    const normalizedDir = this.normalizeAbsolutePath(dir);
    return currentMaps.byId.get(id) || currentMaps.byPath.get(normalizedDir)
      || storedMaps.byId.get(id) || storedMaps.byPath.get(normalizedDir) || {};
  }

  appendBundledPlugin(records, seenIds, dir, currentMaps, storedMaps) {
    try {
      const id = this.discovery.getBundledExtensionId(dir);
      const existing = this.resolveExistingBundledPlugin(id, dir, currentMaps, storedMaps);
      const overrides = this.discovery.getBundledExtensionOverrides(dir, existing);
      const record = this.discovery.buildPluginRecord(dir, existing, overrides);
      if (seenIds.has(record.id)) return;
      seenIds.add(record.id);
      records.push(record);
    } catch (error) {
      this.deps.logger.warn?.('[Extensions] 扫描目录插件失败:', dir, error?.message || error);
    }
  }

  buildBundledPluginRecords() {
    const storedPlugins = this.readStoredState().plugins
      .map(this.discovery.normalizeStoredPlugin).filter((plugin) => plugin && plugin.id);
    const storedMaps = this.getPluginMaps(storedPlugins);
    const currentMaps = this.getPluginMaps(this.state.plugins);
    const records = [];
    const seenIds = new Set();
    for (const dir of this.discovery.collectBundledExtensionDirs()) {
      this.appendBundledPlugin(records, seenIds, dir, currentMaps, storedMaps);
    }
    for (const plugin of storedPlugins) {
      if (!plugin?.id || plugin.builtin === true || seenIds.has(plugin.id)) continue;
      seenIds.add(plugin.id);
      records.push(plugin);
    }
    return records;
  }

  didPublicPluginChange(previous, next) {
    if (!previous || !next) return true;
    const fields = ['id', 'path', 'name', 'rawName', 'description', 'version', 'manifestVersion',
      'enabled', 'builtin', 'iconPath', 'iconRelativePath', 'popupPath', 'optionsPath', 'hint', 'missing'];
    return fields.some((field) => previous[field] !== next[field]);
  }

  shouldReloadPlugin(previous, next) {
    if (!next || next.enabled !== true) return false;
    if (!previous) return true;
    return this.normalizeAbsolutePath(previous.path) !== this.normalizeAbsolutePath(next.path)
      || previous.runtimeSignature !== next.runtimeSignature;
  }

  analyzePluginRecords(nextPlugins) {
    const previousPlugins = Array.isArray(this.state.plugins) ? this.state.plugins : [];
    const previousById = new Map(previousPlugins.map((plugin) => [plugin.id, plugin]));
    const nextById = new Map(nextPlugins.map((plugin) => [plugin.id, plugin]));
    const removedPlugins = previousPlugins.filter((plugin) => plugin?.id && !nextById.has(plugin.id));
    const reloadPairs = [];
    let stateChanged = previousPlugins.length !== nextPlugins.length || removedPlugins.length > 0;
    for (const plugin of nextPlugins) {
      const previous = previousById.get(plugin.id) || null;
      if (this.didPublicPluginChange(previous, plugin)) stateChanged = true;
      if (this.shouldReloadPlugin(previous, plugin)) reloadPairs.push({ previous, plugin });
    }
    return { removedPlugins, reloadPairs, stateChanged };
  }

  updatePluginState(nextPlugins, analysis, options) {
    this.state = { developerModeEnabled: true, plugins: nextPlugins };
    if (analysis.stateChanged || analysis.reloadPairs.length || options.persist === true) this.persistState();
    this.syncLegacyTranslateSetting();
    if (options.emit !== false && (analysis.stateChanged || options.emit === true)) this.emitStateChanged();
  }

  async synchronizePluginSessions(analysis) {
    for (const plugin of analysis.removedPlugins) {
      if (plugin.enabled === true) await this.sessions.unloadPluginFromAllSessions(plugin);
    }
    for (const pair of analysis.reloadPairs) {
      if (pair.previous?.enabled === true) await this.sessions.unloadPluginFromAllSessions(pair.previous);
      await this.sessions.loadPluginIntoAllCurrentSessions(pair.plugin);
    }
  }

  async applyBundledPluginRecords(nextPlugins, options = {}) {
    const analysis = this.analyzePluginRecords(nextPlugins);
    this.updatePluginState(nextPlugins, analysis, options);
    if (options.load !== false) await this.synchronizePluginSessions(analysis);
    return {
      stateChanged: analysis.stateChanged,
      removed: analysis.removedPlugins.length,
      reloaded: analysis.reloadPairs.length,
    };
  }

  async refreshBundledExtensions(options = {}) {
    const nextPlugins = this.buildBundledPluginRecords();
    const result = await this.applyBundledPluginRecords(nextPlugins, options);
    if ((result.stateChanged || result.removed || result.reloaded) && options.reason) {
      this.deps.logger.log?.('[Extensions] 已刷新内置插件目录:', options.reason,
        `插件 ${nextPlugins.length} 个`, `重载 ${result.reloaded} 个`);
    }
    return result;
  }

  async initialize(options = {}) {
    await this.refreshBundledExtensions({ persist: true, load: false, emit: false });
    this.watcher.startRealtimePluginLoading();
    if (options.emit === true) this.emitStateChanged();
    return this.sessions.getPublicState();
  }
}

function createExtensionManager(deps = {}) {
  const runtime = new ExtensionManagerRuntime(deps);
  return {
    BUILTIN_TRANSLATE_ID: config.BUILTIN_TRANSLATE_ID,
    BUILTIN_REMOVE_WATERMARK_ID: config.BUILTIN_REMOVE_WATERMARK_ID,
    initialize: runtime.initialize.bind(runtime),
    getPublicState: runtime.sessions.getPublicState,
    getEnabledExtensionPaths: runtime.sessions.getEnabledExtensionPaths,
    loadEnabledIntoSession: runtime.sessions.loadEnabledIntoSession,
    ensureEnabledPluginsLoadedInCurrentSessions: runtime.sessions.ensureEnabledPluginsLoadedInCurrentSessions,
    importPlugin: runtime.mutations.importPlugin,
    setPluginEnabled: runtime.mutations.setPluginEnabled,
    removePlugin: runtime.mutations.removePlugin,
    isPluginEnabled: runtime.mutations.isPluginEnabled,
  };
}

module.exports = {
  createExtensionManager,
  COMPAT_SHIM_FILE: config.COMPAT_SHIM_FILE,
  sanitizeManifestPermissionsForElectron: config.sanitizeManifestPermissionsForElectron,
};
