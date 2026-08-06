'use strict';

const { app: electronApp } = require('electron');
const fs = require('fs');
const path = require('path');
const { getCoreDir } = require('../../config');

const CLASH_MINI_DIR_NAME = 'clash-mini';
const LOCAL_GEO_FILES = ['geoip.metadb', 'geosite.dat', 'country.mmdb'];
const LOCAL_PROVIDER_FILES = [
  'cn_ip.mrs',
  'cn_domain.mrs',
  'private_domain.mrs',
  'geolocation-!cn.mrs',
];
const LOCAL_ASSET_MARKER_FILE = '.bundled-assets.json';
let clashMiniRuntimePrepPromise = null;
let clashMiniRuntimePrepResult = null;

function copyDirectoryRecursive(src, dest, { overwrite = false } = {}) {
  if (!src || !dest || !fs.existsSync(src)) return false;
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath, { overwrite });
      continue;
    }

    if (!overwrite && fs.existsSync(destPath)) {
      continue;
    }

    try {
      fs.copyFileSync(srcPath, destPath);
    } catch (error) {
      console.warn('[IPC] 复制 Clash Mini 文件失败:', srcPath, '->', destPath, error?.message || error);
    }
  }
  return true;
}

async function copyDirectoryRecursiveAsync(src, dest, { overwrite = false } = {}) {
  if (!src || !dest) return false;
  try {
    await fs.promises.access(src);
  } catch (_) {
    return false;
  }

  await fs.promises.mkdir(dest, { recursive: true });
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryRecursiveAsync(srcPath, destPath, { overwrite });
      return;
    }
    if (!overwrite) {
      try {
        await fs.promises.access(destPath);
        return;
      } catch (_) {}
    }
    await fs.promises.copyFile(srcPath, destPath);
  }));
  return true;
}

function getClashMiniAppRoots() {
  const roots = [];
  try { roots.push(path.join(process.resourcesPath || '', CLASH_MINI_DIR_NAME)); } catch (_) {}
  try { roots.push(path.join(path.dirname(process.execPath || ''), 'resources', CLASH_MINI_DIR_NAME)); } catch (_) {}
  try { roots.push(path.join(process.cwd(), 'resources', CLASH_MINI_DIR_NAME)); } catch (_) {}
  try { roots.push(path.join(__dirname, '..', '..', '..', '..', '..', 'resources', CLASH_MINI_DIR_NAME)); } catch (_) {}
  return Array.from(new Set(roots.filter(Boolean)));
}

function getClashMiniCoreRoots() {
  return getClashMiniAppRoots().map((root) => path.join(root, 'core'));
}

function getClashMiniProfileRoots() {
  const roots = [];
  try { roots.push(path.join(electronApp.getPath('appData'), CLASH_MINI_DIR_NAME)); } catch (_) {}
  try { roots.push(getCoreDir()); } catch (_) {}
  return Array.from(new Set(roots.filter(Boolean)));
}

function resolveBundledClashMiniCoreDir() {
  for (const root of getClashMiniCoreRoots()) {
    if (!root) continue;
    if (
      fs.existsSync(path.join(root, 'verge-mihomo.exe')) ||
      fs.existsSync(path.join(root, 'config.yaml')) ||
      fs.existsSync(path.join(root, 'self.yaml'))
    ) {
      return root;
    }
  }
  return getClashMiniCoreRoots()[0] || null;
}

function getClashMiniRuntimeRoot() {
  try {
    return path.join(electronApp.getPath('appData'), CLASH_MINI_DIR_NAME);
  } catch (_) {
    return path.join(getCoreDir(), CLASH_MINI_DIR_NAME);
  }
}

function resolveClashMiniCoreDir() {
  const runtimeRoot = getClashMiniRuntimeRoot();
  try {
    if (runtimeRoot && fs.existsSync(runtimeRoot)) {
      if (
        fs.existsSync(path.join(runtimeRoot, 'verge-mihomo.exe')) ||
        fs.existsSync(path.join(runtimeRoot, 'config.yaml')) ||
        fs.existsSync(path.join(runtimeRoot, 'self.yaml'))
      ) {
        return runtimeRoot;
      }
    }
  } catch (_) {}

  for (const root of getClashMiniCoreRoots()) {
    if (!root) continue;
    if (
      fs.existsSync(path.join(root, 'verge-mihomo.exe')) ||
      fs.existsSync(path.join(root, 'config.yaml')) ||
      fs.existsSync(path.join(root, 'self.yaml'))
    ) {
      return root;
    }
  }
  return getClashMiniCoreRoots()[0] || null;
}

function resolveClashMiniExecutable(coreDir) {
  if (!coreDir) return null;
  const candidate = path.join(coreDir, 'verge-mihomo.exe');
  return fs.existsSync(candidate) ? candidate : null;
}

function getLocalAssetRelativePaths() {
  return [
    ...LOCAL_GEO_FILES,
    ...LOCAL_PROVIDER_FILES.map((name) => path.join('providers', name)),
  ];
}

function buildLocalAssetManifest(bundledCore) {
  const files = [];
  for (const relativePath of getLocalAssetRelativePaths()) {
    const src = path.join(bundledCore, relativePath);
    try {
      const stat = fs.statSync(src);
      files.push({
        path: relativePath.replace(/\\/g, '/'),
        size: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
      });
    } catch (_) {}
  }
  return {
    signature: files.map((item) => `${item.path}:${item.size}:${item.mtimeMs}`).join('|'),
    files,
  };
}

function readLocalAssetMarker(runtimeDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(runtimeDir, LOCAL_ASSET_MARKER_FILE), 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch (_) {
    return null;
  }
}

function writeLocalAssetMarker(runtimeDir, manifest) {
  const markerPath = path.join(runtimeDir, LOCAL_ASSET_MARKER_FILE);
  fs.writeFileSync(markerPath, `${JSON.stringify(manifest)}\n`, 'utf8');
}

async function writeLocalAssetMarkerAsync(runtimeDir, manifest) {
  const markerPath = path.join(runtimeDir, LOCAL_ASSET_MARKER_FILE);
  await fs.promises.writeFile(markerPath, `${JSON.stringify(manifest)}\n`, 'utf8');
}

function isLocalAssetSizeCurrent(runtimeDir, item) {
  try {
    return fs.statSync(path.join(runtimeDir, item.path)).size === item.size;
  } catch (_) {
    return false;
  }
}

// 内置 Geo 库/规则集以内置版本为准。版本未变化且文件大小正确时跳过复制，
// 版本升级或检测到残缺文件时再覆盖，兼顾启动速度与离线分流稳定性。
function syncLocalGeoAssets(runtimeDir) {
  const bundledCore = resolveBundledClashMiniCoreDir();
  if (!bundledCore) {
    return { ok: false, copied: [], missing: [], error: '未找到内置 core 目录' };
  }

  const manifest = buildLocalAssetManifest(bundledCore);
  const marker = readLocalAssetMarker(runtimeDir);
  const markerMatches = !!manifest.signature && marker?.signature === manifest.signature;
  const copied = [];
  const skipped = [];
  const missing = [];
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      copied,
      missing,
      error: error?.message || String(error),
    };
  }

  const copyAsset = (relativePath) => {
    const src = path.join(bundledCore, relativePath);
    const dest = path.join(runtimeDir, relativePath);
    if (!fs.existsSync(src)) {
      missing.push(relativePath.replace(/\\/g, '/'));
      return;
    }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const manifestItem = manifest.files.find((item) => item.path === relativePath.replace(/\\/g, '/'));
      if ((markerMatches || !marker) && manifestItem && isLocalAssetSizeCurrent(runtimeDir, manifestItem)) {
        skipped.push(relativePath.replace(/\\/g, '/'));
        return;
      }
      if (path.resolve(src) !== path.resolve(dest)) {
        fs.copyFileSync(src, dest);
      }
      copied.push(relativePath.replace(/\\/g, '/'));
    } catch (_) {
      missing.push(relativePath.replace(/\\/g, '/'));
    }
  };

  for (const relativePath of getLocalAssetRelativePaths()) copyAsset(relativePath);

  if (missing.length === 0 && manifest.signature) {
    try {
      writeLocalAssetMarker(runtimeDir, manifest);
    } catch (error) {
      return { ok: false, copied, skipped, missing, error: error?.message || String(error) };
    }
  }

  return { ok: missing.length === 0, copied, skipped, missing };
}

async function syncLocalGeoAssetsAsync(runtimeDir) {
  const bundledCore = resolveBundledClashMiniCoreDir();
  if (!bundledCore) {
    return { ok: false, copied: [], skipped: [], missing: [], error: '未找到内置 core 目录' };
  }

  const manifest = buildLocalAssetManifest(bundledCore);
  const marker = readLocalAssetMarker(runtimeDir);
  const markerMatches = !!manifest.signature && marker?.signature === manifest.signature;
  const copied = [];
  const skipped = [];
  const missing = [];
  await fs.promises.mkdir(runtimeDir, { recursive: true });

  await Promise.all(getLocalAssetRelativePaths().map(async (relativePath) => {
    const normalizedPath = relativePath.replace(/\\/g, '/');
    const src = path.join(bundledCore, relativePath);
    const dest = path.join(runtimeDir, relativePath);
    let sourceStat;
    try {
      sourceStat = await fs.promises.stat(src);
    } catch (_) {
      missing.push(normalizedPath);
      return;
    }
    const manifestItem = { path: normalizedPath, size: sourceStat.size };
    if ((markerMatches || !marker) && isLocalAssetSizeCurrent(runtimeDir, manifestItem)) {
      skipped.push(normalizedPath);
      return;
    }
    try {
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      if (path.resolve(src) !== path.resolve(dest)) {
        await fs.promises.copyFile(src, dest);
      }
      copied.push(normalizedPath);
    } catch (_) {
      missing.push(normalizedPath);
    }
  }));

  if (missing.length === 0 && manifest.signature) {
    try {
      await writeLocalAssetMarkerAsync(runtimeDir, manifest);
    } catch (error) {
      return { ok: false, copied, skipped, missing, error: error?.message || String(error) };
    }
  }

  return { ok: missing.length === 0, copied, skipped, missing };
}

async function prepareClashMiniRuntimeDirAsync() {
  if (
    clashMiniRuntimePrepResult?.ok
    && clashMiniRuntimePrepResult.exePath
    && fs.existsSync(clashMiniRuntimePrepResult.exePath)
  ) {
    return { ...clashMiniRuntimePrepResult, cached: true };
  }
  if (clashMiniRuntimePrepPromise) return clashMiniRuntimePrepPromise;

  const task = (async () => {
    const startedAt = Date.now();
    const sourceDir = resolveBundledClashMiniCoreDir();
    if (!sourceDir || !fs.existsSync(sourceDir)) {
      return { ok: false, error: `未找到 Clash Mini 源目录: ${sourceDir || 'unknown'}` };
    }
    const runtimeDir = getClashMiniRuntimeRoot();
    try {
      await fs.promises.mkdir(runtimeDir, { recursive: true });
      if (path.resolve(runtimeDir) !== path.resolve(sourceDir)) {
        await copyDirectoryRecursiveAsync(sourceDir, runtimeDir, { overwrite: false });
      }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }

    const exePath = resolveClashMiniExecutable(runtimeDir);
    if (!exePath) {
      return { ok: false, error: 'Clash Mini 运行目录中未找到 verge-mihomo.exe' };
    }
    const assetSync = await syncLocalGeoAssetsAsync(runtimeDir);
    const result = {
      ok: true,
      sourceDir,
      runtimeDir,
      exePath,
      assetSync,
      elapsedMs: Date.now() - startedAt,
    };
    if (assetSync.ok) clashMiniRuntimePrepResult = result;
    return result;
  })();

  clashMiniRuntimePrepPromise = task;
  try {
    return await task;
  } finally {
    if (clashMiniRuntimePrepPromise === task) clashMiniRuntimePrepPromise = null;
  }
}

function purgeClashMiniRuntimeConfigFiles(coreDir) {
  const targets = [
    path.join(coreDir, 'config.yaml'),
    path.join(coreDir, 'self.yaml'),
    path.join(coreDir, 'profiles.yaml'),
  ];
  const removed = [];
  const failed = [];

  for (const target of targets) {
    try {
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
        removed.push(path.basename(target));
      }
    } catch (error) {
      failed.push({ file: path.basename(target), error: error?.message || String(error) });
    }
  }

  return { ok: failed.length === 0, removed, failed };
}

module.exports = {
  CLASH_MINI_DIR_NAME,
  copyDirectoryRecursive,
  copyDirectoryRecursiveAsync,
  getClashMiniAppRoots,
  getClashMiniCoreRoots,
  getClashMiniProfileRoots,
  resolveBundledClashMiniCoreDir,
  getClashMiniRuntimeRoot,
  resolveClashMiniCoreDir,
  resolveClashMiniExecutable,
  getLocalAssetRelativePaths,
  buildLocalAssetManifest,
  readLocalAssetMarker,
  writeLocalAssetMarker,
  writeLocalAssetMarkerAsync,
  isLocalAssetSizeCurrent,
  syncLocalGeoAssets,
  syncLocalGeoAssetsAsync,
  prepareClashMiniRuntimeDirAsync,
  purgeClashMiniRuntimeConfigFiles,
};
