'use strict';

const { buildElectronExtensionCompatShim } = require('./electron-compat-shim');

function prependShimToScript(deps, scriptPath, shimText) {
  try {
    if (!scriptPath || !deps.fs.existsSync(scriptPath)) return false;
    const current = deps.fs.readFileSync(scriptPath, 'utf8');
    if (current.includes(deps.compatShimMarker)) return false;
    deps.fs.writeFileSync(scriptPath, `${shimText}\n${current}`, 'utf8');
    return true;
  } catch (error) {
    deps.logger.warn?.('[Extensions] 注入扩展后台兼容脚本失败:', scriptPath, error?.message || error);
    return false;
  }
}

function resolveRelativeShimPath(deps, htmlPath, rootDir) {
  if (!rootDir) return deps.compatShimFile;
  const relative = deps.path.relative(deps.path.dirname(htmlPath), deps.path.join(rootDir, deps.compatShimFile)).replace(/\\/g, '/');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

function injectShimIntoHtml(deps, htmlPath, rootDir) {
  try {
    if (!htmlPath || !deps.fs.existsSync(htmlPath)) return false;
    const current = deps.fs.readFileSync(htmlPath, 'utf8');
    if (current.includes(deps.compatShimFile)) return false;
    const tag = `<script src="${resolveRelativeShimPath(deps, htmlPath, rootDir)}"></script>`;
    let next = `${tag}\n${current}`;
    if (/<\/head>/i.test(current)) next = current.replace(/<\/head>/i, `${tag}\n</head>`);
    else if (/<script\b/i.test(current)) next = current.replace(/<script\b/i, `${tag}\n<script`);
    deps.fs.writeFileSync(htmlPath, next, 'utf8');
    return true;
  } catch (error) {
    deps.logger.warn?.('[Extensions] 注入扩展页面兼容脚本失败:', htmlPath, error?.message || error);
    return false;
  }
}

function patchBackground(deps, compatDir, manifest, shimText) {
  const background = manifest.background && typeof manifest.background === 'object' ? manifest.background : null;
  if (background?.service_worker) {
    const workerPath = deps.path.join(compatDir, String(background.service_worker).replace(/^\/+/, ''));
    prependShimToScript(deps, workerPath, shimText);
    return false;
  }
  if (Array.isArray(background?.scripts)) {
    const scripts = background.scripts.map((item) => String(item || '').trim()).filter(Boolean);
    if (scripts.includes(deps.compatShimFile)) return false;
    background.scripts = [deps.compatShimFile, ...scripts];
    return true;
  }
  if (background?.page) {
    injectShimIntoHtml(deps, deps.path.join(compatDir, String(background.page).replace(/^\/+/, '')), compatDir);
  }
  return false;
}

function patchCompatExtensionDirectory(deps, compatDir) {
  const manifestPath = deps.path.join(compatDir, 'manifest.json');
  const sourceManifest = deps.readJsonFile(manifestPath);
  if (!sourceManifest || typeof sourceManifest !== 'object') throw new Error('运行时插件副本缺少有效 manifest.json');
  const sanitized = deps.sanitizeManifestPermissionsForElectron(sourceManifest);
  const manifest = sanitized.manifest;
  const shimText = buildElectronExtensionCompatShim(deps.compatShimMarker);
  deps.fs.writeFileSync(deps.path.join(compatDir, deps.compatShimFile), shimText, 'utf8');
  const backgroundChanged = patchBackground(deps, compatDir, manifest, shimText);
  const htmlFiles = deps.listExtensionTextFiles(compatDir, { maxFiles: 800, maxBytes: 1024 * 1024 }).files
    .filter((filePath) => ['.html', '.htm'].includes(deps.path.extname(filePath).toLowerCase()));
  htmlFiles.forEach((filePath) => injectShimIntoHtml(deps, filePath, compatDir));
  if (backgroundChanged || sanitized.removedPermissions.length) {
    deps.fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  if (sanitized.removedPermissions.length) {
    deps.logger.log?.('[Extensions] Electron 兼容层已处理不识别的权限声明:', sanitized.removedPermissions.join(', '));
  }
}

function buildCompatPaths(deps, plugin, sourcePath, scan) {
  const cacheRoot = deps.resolveCompatCacheRoot();
  const signature = deps.hashId([
    sourcePath, plugin?.version || '', scan.latestMtimeMs, scan.fileCount, scan.requiredApiRoots.join(','),
    deps.compatShimMarker, deps.compatShimFile, deps.compatCacheSchema,
  ].join('|'));
  const cacheName = [
    deps.toSafeFileName(plugin?.id || deps.path.basename(sourcePath)),
    deps.hashId(sourcePath), signature,
  ].join('-');
  const compatDir = deps.path.join(cacheRoot, cacheName);
  return { cacheRoot, compatDir, signature, signaturePath: deps.path.join(compatDir, '.compat-signature') };
}

function isCompatCacheCurrent(deps, paths) {
  try {
    return deps.fs.existsSync(deps.path.join(paths.compatDir, 'manifest.json'))
      && deps.fs.existsSync(paths.signaturePath)
      && deps.fs.readFileSync(paths.signaturePath, 'utf8') === paths.signature;
  } catch (_) {
    return false;
  }
}

function createCompatStagingPath(deps, paths) {
  const suffix = deps.hashId(`${process.pid}|${Date.now()}|${Math.random()}|${paths.signature}`);
  return `${paths.compatDir}.staging-${process.pid}-${suffix}`;
}

function removeCompatDirectory(deps, cacheRoot, directory) {
  if (!directory || !deps.fs.existsSync(directory)) return;
  if (!deps.isPathInside(cacheRoot, directory)) throw new Error('兼容缓存目录校验失败');
  deps.fs.rmSync(directory, { recursive: true, force: true });
}

function publishCompatCopy(deps, paths, stagingDir) {
  if (isCompatCacheCurrent(deps, paths)) {
    removeCompatDirectory(deps, paths.cacheRoot, stagingDir);
    return paths.compatDir;
  }
  deps.fs.renameSync(stagingDir, paths.compatDir);
  if (!isCompatCacheCurrent(deps, paths)) throw new Error('兼容副本原子发布后校验失败');
  return paths.compatDir;
}

function recoverCompatCopyFailure(deps, plugin, sourcePath, paths, stagingDir, error) {
  try { removeCompatDirectory(deps, paths.cacheRoot, stagingDir); } catch (_) {}
  if (isCompatCacheCurrent(deps, paths)) return paths.compatDir;
  deps.logger.warn?.('[Extensions] 创建插件兼容副本失败，回退原目录:', plugin?.name || plugin?.id || sourcePath, error?.message || error);
  return sourcePath;
}

function createCompatCopy(deps, plugin, sourcePath, paths) {
  const stagingDir = createCompatStagingPath(deps, paths);
  try {
    deps.fs.mkdirSync(paths.cacheRoot, { recursive: true });
    deps.copyDirectoryRecursive(sourcePath, stagingDir);
    patchCompatExtensionDirectory(deps, stagingDir);
    deps.fs.writeFileSync(deps.path.join(stagingDir, '.compat-signature'), paths.signature, 'utf8');
    publishCompatCopy(deps, paths, stagingDir);
    deps.logger.log?.('[Extensions] 已为插件创建 Electron 兼容副本:', plugin?.name || plugin?.id || sourcePath);
    return paths.compatDir;
  } catch (error) {
    return recoverCompatCopyFailure(deps, plugin, sourcePath, paths, stagingDir, error);
  }
}

function prepareCompatExtensionPath(deps, plugin) {
  const sourcePath = deps.normalizeAbsolutePath(plugin?.path);
  if (!sourcePath) return '';
  const scan = deps.scanExtensionCompatNeeds(sourcePath);
  if (!scan.needsCompatShim) return sourcePath;
  const paths = buildCompatPaths(deps, plugin, sourcePath, scan);
  return isCompatCacheCurrent(deps, paths) ? paths.compatDir : createCompatCopy(deps, plugin, sourcePath, paths);
}

function createExtensionCompatService(deps = {}) {
  const normalizedDeps = { ...deps, logger: deps.logger || console };
  return { prepareCompatExtensionPath: (plugin) => prepareCompatExtensionPath(normalizedDeps, plugin) };
}

module.exports = { createExtensionCompatService };
