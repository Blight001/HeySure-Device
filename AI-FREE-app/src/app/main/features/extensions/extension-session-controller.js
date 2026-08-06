'use strict';

class ExtensionSessionController {
  constructor(deps = {}) {
    this.deps = deps;
    this.logger = deps.logger || console;
    this.sessionExtensionIds = new WeakMap();
    this.knownSessions = new Set();
  }

  getIconDataUrl(plugin) {
    try {
      if (!plugin?.iconPath || !this.deps.fs.existsSync(plugin.iconPath)) return '';
      const ext = this.deps.path.extname(plugin.iconPath).toLowerCase();
      const mime = this.resolveIconMime(ext);
      const data = this.deps.fs.readFileSync(plugin.iconPath);
      return `data:${mime};base64,${data.toString('base64')}`;
    } catch (_) {
      return '';
    }
  }

  resolveIconMime(ext) {
    return ({ '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' })[ext]
      || 'image/png';
  }

  toPublicPlugin(plugin) {
    return {
      id: plugin.id,
      name: plugin.name || plugin.rawName || '未命名插件',
      rawName: plugin.rawName || '',
      description: plugin.description || '',
      version: plugin.version || '',
      enabled: plugin.enabled === true,
      builtin: plugin.builtin === true,
      missing: plugin.missing === true,
      hint: plugin.hint || '',
      path: plugin.path || '',
      iconDataUrl: this.getIconDataUrl(plugin),
    };
  }

  getPublicState() {
    return {
      developerModeEnabled: true,
      plugins: this.deps.getState().plugins.map((plugin) => this.toPublicPlugin(plugin)),
    };
  }

  getEnabledExtensionPaths() {
    const seen = new Set();
    const paths = [];
    for (const plugin of this.deps.getState().plugins) {
      const pluginPath = this.resolveEnabledPluginPath(plugin);
      if (!pluginPath || seen.has(pluginPath) || !this.hasManifest(pluginPath)) continue;
      seen.add(pluginPath);
      paths.push(pluginPath);
    }
    return paths;
  }

  resolveEnabledPluginPath(plugin) {
    if (plugin?.enabled !== true || plugin?.missing === true) return '';
    const source = this.deps.prepareCompatExtensionPath(plugin) || plugin.path;
    return this.deps.normalizeAbsolutePath(source);
  }

  hasManifest(pluginPath) {
    try {
      return this.deps.fs.existsSync(this.deps.path.join(pluginPath, 'manifest.json'));
    } catch (_) {
      return false;
    }
  }

  getPluginById(pluginId) {
    const id = String(pluginId || '').trim();
    return this.deps.getState().plugins.find((plugin) => plugin.id === id) || null;
  }

  rememberSession(session) {
    if (!session) return null;
    this.knownSessions.add(session);
    let map = this.sessionExtensionIds.get(session);
    if (!map) {
      map = new Map();
      this.sessionExtensionIds.set(session, map);
    }
    return map;
  }

  getLoadedExtensions(session) {
    try {
      const all = typeof session?.extensions?.getAllExtensions === 'function'
        ? session.extensions.getAllExtensions()
        : null;
      if (Array.isArray(all)) return all;
      if (all && typeof all === 'object') return Object.values(all);
    } catch (_) {}
    return [];
  }

  findLoadedExtension(session, plugin) {
    const normalizedPath = this.deps.normalizeAbsolutePath(plugin.path);
    const rememberedId = this.rememberSession(session)?.get(plugin.id);
    return this.getLoadedExtensions(session).find((extension) => (
      this.matchesLoadedExtension(extension, plugin, normalizedPath, rememberedId)
    )) || null;
  }

  matchesLoadedExtension(extension, plugin, normalizedPath, rememberedId) {
    const extensionPath = this.deps.normalizeAbsolutePath(extension?.path || '');
    if (extensionPath && normalizedPath && extensionPath === normalizedPath) return true;
    if (extension?.id && rememberedId === extension.id) return true;
    const manifestName = extension?.manifest?.name || '';
    return Boolean(plugin.rawName)
      && [extension?.name, manifestName].includes(plugin.rawName);
  }

  async loadPluginIntoSession(plugin, session, label = '') {
    if (!this.canLoad(plugin, session)) return null;
    const map = this.rememberSession(session);
    const existing = this.findLoadedExtension(session, plugin);
    if (existing?.id) {
      map.set(plugin.id, existing.id);
      return existing;
    }
    try {
      return await this.loadNewExtension(plugin, session, label, map);
    } catch (error) {
      return this.recoverFailedLoad(plugin, session, label, map, error);
    }
  }

  canLoad(plugin, session) {
    return Boolean(plugin)
      && plugin.enabled === true
      && plugin.missing !== true
      && typeof session?.extensions?.loadExtension === 'function';
  }

  async loadNewExtension(plugin, session, label, map) {
    const loadPath = this.resolveEnabledPluginPath(plugin);
    if (!loadPath || !this.hasManifest(loadPath)) {
      throw new Error(`插件运行目录无效: ${loadPath || plugin?.path || '(空路径)'}`);
    }
    const extension = await session.extensions.loadExtension(loadPath, { allowFileAccess: true });
    if (extension?.id) map.set(plugin.id, extension.id);
    this.logger.log?.('[Extensions] 插件已加载', label ? `(${label})` : '', plugin.name, extension?.id || '');
    return extension || null;
  }

  recoverFailedLoad(plugin, session, label, map, error) {
    const message = error?.message || String(error);
    if (/already loaded|exists/i.test(message)) {
      const fallback = this.findLoadedExtension(session, plugin);
      if (fallback?.id) {
        map.set(plugin.id, fallback.id);
        return fallback;
      }
    }
    this.logger.warn?.('[Extensions] 插件加载失败', label ? `(${label})` : '', plugin.name, message);
    return null;
  }

  async loadEnabledIntoSession(session, label = '') {
    if (!session) return { ok: false, loaded: 0 };
    this.rememberSession(session);
    let loaded = 0;
    for (const plugin of this.deps.getState().plugins) {
      if (plugin.enabled !== true) continue;
      if (await this.loadPluginIntoSession(plugin, session, label)) loaded += 1;
    }
    return { ok: true, loaded };
  }

  collectSessions() {
    return Array.from(this.knownSessions).filter(Boolean);
  }

  async unloadPluginFromSession(plugin, session) {
    if (!plugin || !session) return false;
    const map = this.rememberSession(session);
    const extensionId = map.get(plugin.id) || this.findLoadedExtension(session, plugin)?.id || '';
    if (!extensionId) return false;
    try {
      if (!await this.removeExtensionFromSession(session, extensionId)) return false;
      map.delete(plugin.id);
      this.logger.log?.('[Extensions] 插件已卸载:', plugin.name, extensionId);
      return true;
    } catch (error) {
      this.logger.warn?.('[Extensions] 插件卸载失败:', plugin.name, error?.message || error);
      return false;
    }
  }

  async removeExtensionFromSession(session, extensionId) {
    if (typeof session.extensions?.removeExtension === 'function') {
      await Promise.resolve(session.extensions.removeExtension(extensionId));
      return true;
    }
    if (typeof session.removeExtension === 'function') {
      await Promise.resolve(session.removeExtension(extensionId));
      return true;
    }
    return false;
  }

  async unloadPluginFromAllSessions(plugin) {
    await Promise.all(this.collectSessions().map((session) => this.unloadPluginFromSession(plugin, session)));
  }

  async loadPluginIntoAllCurrentSessions(plugin) {
    await Promise.all(this.collectSessions().map((session) => this.loadPluginIntoSession(plugin, session, '现有标签')));
  }

  async ensureEnabledPluginsLoadedInCurrentSessions(label = '巡检') {
    const sessions = this.collectSessions();
    if (!sessions.length) return { ok: true, sessions: 0, loaded: 0 };
    const results = await Promise.all(sessions.map((session) => this.loadEnabledIntoSession(session, label)));
    const loaded = results.reduce((total, result) => total + Number(result?.loaded || 0), 0);
    return { ok: true, sessions: sessions.length, loaded };
  }

  getApi() {
    const methods = [
      'getIconDataUrl', 'toPublicPlugin', 'getPublicState', 'getEnabledExtensionPaths',
      'getPluginById', 'rememberSession', 'getLoadedExtensions', 'findLoadedExtension',
      'loadPluginIntoSession', 'loadEnabledIntoSession', 'collectSessions',
      'unloadPluginFromSession', 'unloadPluginFromAllSessions', 'loadPluginIntoAllCurrentSessions',
      'ensureEnabledPluginsLoadedInCurrentSessions',
    ];
    return Object.fromEntries(methods.map((name) => [name, (...args) => this[name](...args)]));
  }
}

function createExtensionSessionController(deps = {}) {
  return new ExtensionSessionController(deps).getApi();
}

module.exports = { createExtensionSessionController };
