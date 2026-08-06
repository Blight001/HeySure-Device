'use strict';

class ExtensionDiscoveryService {
  constructor(deps = {}) {
    this.deps = /** @type {Record<string, any>} */ ({ logger: console, ...deps });
  }

  resolveBundledExtensionCandidates() {
    const { app, path } = this.deps;
    const candidates = [];
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'assets', 'extensions'));
      candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'extensions'));
      candidates.push(path.join(process.resourcesPath, 'src', 'assets', 'extensions'));
    }
    if (app && typeof app.getAppPath === 'function') {
      candidates.push(path.join(app.getAppPath(), 'src', 'assets', 'extensions'));
      candidates.push(path.join(app.getAppPath(), 'assets', 'extensions'));
    }
    candidates.push(path.join(__dirname, '../../../assets/extensions'));
    return candidates;
  }

  resolveBundledExtensionRoots() {
    const { fs, normalizeAbsolutePath } = this.deps;
    const roots = [];
    const seen = new Set();
    for (const candidate of this.resolveBundledExtensionCandidates()) {
      const normalized = normalizeAbsolutePath(candidate);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      try { if (fs.existsSync(normalized)) roots.push(normalized); } catch (_) {}
    }
    return roots;
  }

  addBundledExtensionDir(dirsByName, dir) {
    const { fs, normalizeAbsolutePath, path } = this.deps;
    const normalized = normalizeAbsolutePath(dir);
    if (!normalized) return;
    try {
      if (!fs.existsSync(path.join(normalized, 'manifest.json'))) return;
      const key = path.basename(normalized).toLowerCase();
      if (!dirsByName.has(key)) dirsByName.set(key, normalized);
    } catch (_) {}
  }

  collectRootExtensionDirs(root) {
    const { fs, logger, path } = this.deps;
    try {
      return fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
    } catch (error) {
      logger.warn?.('[Extensions] 扫描内置插件目录失败:', root, error?.message || error);
      return [];
    }
  }

  collectBundledExtensionDirs() {
    const dirsByName = new Map();
    this.addBundledExtensionDir(dirsByName, this.resolveBuiltinTranslateDir());
    for (const root of this.resolveBundledExtensionRoots()) {
      this.addBundledExtensionDir(dirsByName, root);
      this.collectRootExtensionDirs(root).forEach((dir) => this.addBundledExtensionDir(dirsByName, dir));
    }
    return Array.from(dirsByName.values()).sort((a, b) => this.deps.path.basename(a).localeCompare(this.deps.path.basename(b)));
  }

  getBundledExtensionId(dir) {
    const dirName = this.deps.path.basename(String(dir || '')).trim();
    const normalizedName = dirName.toLowerCase();
    if (normalizedName === 'transform') return this.deps.builtinTranslateId;
    if (normalizedName === 'remove_watermark') return this.deps.builtinRemoveWatermarkId;
    const safeName = normalizedName.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return `asset-${safeName || this.deps.hashId(dirName || dir)}`;
  }

  getBundledExtensionOverrides(dir, existing = {}) {
    const dirName = this.deps.path.basename(String(dir || '')).trim().toLowerCase();
    const overrides = { id: this.getBundledExtensionId(dir), builtin: true, enabled: existing.enabled !== false };
    if (dirName === 'transform') {
      overrides.name = existing.name || '翻译插件';
      overrides.hint = existing.hint || '点击网页右侧粉色按钮翻译';
    } else if (dirName === 'remove_watermark') {
      overrides.name = existing.name || '去水印插件';
      overrides.hint = existing.hint || '右键视频图片直接下载';
    }
    return overrides;
  }

  resolveMessages(dir, locale) {
    const json = this.deps.readJsonFile(this.deps.path.join(dir, '_locales', locale, 'messages.json'));
    return json && typeof json === 'object' ? json : null;
  }

  resolveManifestText(dir, manifest, value) {
    const text = String(value || '').trim();
    const match = text.match(/^__MSG_([^_]+(?:_[^_]+)*)__$/);
    if (!match) return text;
    const messageKey = match[1];
    const locales = ['zh_CN', 'zh', String(manifest?.default_locale || '').trim(), 'en'].filter(Boolean);
    const seen = new Set();
    for (const locale of locales) {
      if (seen.has(locale)) continue;
      seen.add(locale);
      const message = this.resolveMessages(dir, locale)?.[messageKey]?.message;
      if (message) return String(message);
    }
    return messageKey;
  }

  readManifest(dir) {
    const manifest = this.deps.readJsonFile(this.deps.path.join(dir, 'manifest.json'));
    if (!manifest || typeof manifest !== 'object') throw new Error('所选目录没有有效的 manifest.json');
    if (!manifest.manifest_version) throw new Error('manifest.json 缺少 manifest_version');
    return manifest;
  }

  normalizeIconCandidate(iconValue) {
    if (!iconValue) return '';
    if (typeof iconValue === 'string') return iconValue;
    if (typeof iconValue !== 'object') return '';
    const entries = Object.entries(iconValue)
      .map(([size, iconPath]) => ({ size: Number(size), iconPath: String(iconPath || '') }))
      .filter((entry) => entry.iconPath).sort((a, b) => b.size - a.size);
    return entries[0]?.iconPath || '';
  }

  resolveIconPath(dir, manifest) {
    const actionIcon = this.normalizeIconCandidate(manifest?.action?.default_icon
      || manifest?.browser_action?.default_icon || manifest?.page_action?.default_icon);
    const relativePath = String(actionIcon || this.normalizeIconCandidate(manifest?.icons) || '').replace(/^\/+/, '');
    if (!relativePath) return { iconPath: '', iconRelativePath: '' };
    const iconPath = this.deps.path.join(dir, relativePath);
    return { iconPath: this.deps.fs.existsSync(iconPath) ? iconPath : '', iconRelativePath: relativePath };
  }

  resolvePopupPath(manifest) {
    return String(manifest?.action?.default_popup || manifest?.browser_action?.default_popup
      || manifest?.page_action?.default_popup || '').replace(/^\/+/, '').trim();
  }

  resolveOptionsPath(manifest) {
    return String(manifest?.options_page || manifest?.options_ui?.page || '').replace(/^\/+/, '').trim();
  }

  getPluginRuntimeSignature(dir, manifest = {}) {
    try {
      const scan = this.deps.listExtensionTextFiles(dir, { maxFiles: 1200, maxBytes: 4 * 1024 * 1024 });
      const manifestMtimeMs = this.getManifestMtime(dir);
      return this.deps.hashId([this.deps.normalizeAbsolutePath(dir), manifest?.manifest_version || '',
        manifest?.version || '', manifestMtimeMs, scan.latestMtimeMs, scan.fileCount].join('|'));
    } catch (_) {
      return this.deps.hashId([this.deps.normalizeAbsolutePath(dir), manifest?.version || '', 'signature-fallback'].join('|'));
    }
  }

  getManifestMtime(dir) {
    try { return Number(this.deps.fs.statSync(this.deps.path.join(dir, 'manifest.json')).mtimeMs) || 0; } catch (_) { return 0; }
  }

  resolvePluginFlag(overrides, existing, key) {
    if (overrides[key] !== undefined) return overrides[key] === true;
    return existing[key] === true;
  }

  buildPluginRecord(dir, existing = {}, overrides = {}) {
    const absPath = this.deps.normalizeAbsolutePath(dir);
    const manifest = this.readManifest(absPath);
    const rawName = this.resolveManifestText(absPath, manifest, manifest.name) || this.deps.path.basename(absPath);
    const icon = this.resolveIconPath(absPath, manifest);
    const now = new Date().toISOString();
    return {
      id: String(overrides.id || existing.id || `local-${this.deps.hashId(absPath)}`).trim(),
      path: absPath,
      name: String(overrides.name || existing.name || rawName || this.deps.path.basename(absPath)).trim(),
      rawName,
      description: this.resolveManifestText(absPath, manifest, manifest.description) || '',
      version: String(manifest.version || ''),
      manifestVersion: Number(manifest.manifest_version) || null,
      enabled: this.resolvePluginFlag(overrides, existing, 'enabled'),
      builtin: this.resolvePluginFlag(overrides, existing, 'builtin'),
      iconPath: icon.iconPath,
      iconRelativePath: icon.iconRelativePath,
      popupPath: this.resolvePopupPath(manifest),
      optionsPath: this.resolveOptionsPath(manifest),
      hint: String(overrides.hint || existing.hint || '').trim(),
      importedAt: existing.importedAt || now,
      updatedAt: now,
      runtimeSignature: this.getPluginRuntimeSignature(absPath, manifest),
    };
  }

  normalizeStoredPlugin(plugin) {
    try {
      const absPath = this.deps.normalizeAbsolutePath(plugin?.path);
      if (!absPath || !this.deps.fs.existsSync(this.deps.path.join(absPath, 'manifest.json'))) {
        return { ...(plugin || {}), path: absPath, missing: true, enabled: false };
      }
      return this.buildPluginRecord(absPath, plugin || {});
    } catch (error) {
      this.deps.logger.warn?.('[Extensions] 插件记录解析失败:', plugin?.path, error?.message || error);
      return { ...(plugin || {}), missing: true, enabled: false };
    }
  }

  resolveBuiltinTranslateDir() {
    try {
      if (typeof this.deps.getTranslateExtDir !== 'function') return '';
      const dir = this.deps.getTranslateExtDir();
      if (dir && this.deps.fs.existsSync(this.deps.path.join(dir, 'manifest.json'))) return dir;
    } catch (_) {}
    return '';
  }
}

function createExtensionDiscoveryService(deps) {
  const service = new ExtensionDiscoveryService(deps);
  const methods = ['resolveBundledExtensionRoots', 'collectBundledExtensionDirs', 'getBundledExtensionId',
    'getBundledExtensionOverrides', 'resolveMessages', 'resolveManifestText', 'readManifest', 'normalizeIconCandidate',
    'resolveIconPath', 'resolvePopupPath', 'resolveOptionsPath', 'getPluginRuntimeSignature', 'buildPluginRecord',
    'normalizeStoredPlugin', 'resolveBuiltinTranslateDir'];
  return Object.fromEntries(methods.map((name) => [name, service[name].bind(service)]));
}

module.exports = { createExtensionDiscoveryService };
