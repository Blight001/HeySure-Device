'use strict';

const TEXT_EXTENSION_NAMES = new Set(['.js', '.mjs', '.cjs', '.html', '.htm', '.json']);
const SKIPPED_DIRECTORY_NAMES = new Set(['.git', 'node_modules', '.cache']);

function toSafeFileName(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'extension';
}

function isPathInside(path, parentDir, childPath) {
  try {
    const relative = path.relative(path.resolve(parentDir), path.resolve(childPath));
    return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  } catch (_) {
    return false;
  }
}

function resolveCompatCacheRoot({ app, path, compatCacheDirName }) {
  try {
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), compatCacheDirName);
    }
  } catch (_) {}
  return path.join(process.cwd(), '.extension-runtime-compat');
}

function copyDirectoryRecursive({ fs, path }, sourceDir, targetDir) {
  if (typeof fs.cpSync === 'function') {
    fs.cpSync(sourceDir, targetDir, { recursive: true, force: true, dereference: false, errorOnExist: false });
    return;
  }
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    copyExtensionEntry({ fs, path }, sourceDir, targetDir, entry);
  }
}

function copyExtensionEntry(deps, sourceDir, targetDir, entry) {
  const sourcePath = deps.path.join(sourceDir, entry.name);
  const targetPath = deps.path.join(targetDir, entry.name);
  if (entry.isDirectory()) return copyDirectoryRecursive(deps, sourcePath, targetPath);
  if (entry.isSymbolicLink()) return deps.fs.symlinkSync(deps.fs.readlinkSync(sourcePath), targetPath);
  if (entry.isFile()) deps.fs.copyFileSync(sourcePath, targetPath);
}

function readExtensionDirectoryEntries(fs, dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
}

function collectExtensionTextFiles(deps, state, dir) {
  if (state.files.length >= state.maxFiles) return;
  for (const entry of readExtensionDirectoryEntries(deps.fs, dir)) {
    if (state.files.length >= state.maxFiles) return;
    if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
    collectExtensionTextEntry(deps, state, dir, entry);
  }
}

function collectExtensionTextEntry({ fs, path }, state, dir, entry) {
  const entryPath = path.join(dir, entry.name);
  if (entry.isDirectory()) return collectExtensionTextFiles({ fs, path }, state, entryPath);
  if (!entry.isFile() || !TEXT_EXTENSION_NAMES.has(path.extname(entry.name).toLowerCase())) return;
  try {
    const stat = fs.statSync(entryPath);
    state.latestMtimeMs = Math.max(state.latestMtimeMs, Number(stat.mtimeMs) || 0);
    if (stat.size <= state.maxBytes) state.files.push(entryPath);
  } catch (_) {}
}

function listExtensionTextFiles(deps, rootDir, options = {}) {
  const state = {
    files: [],
    latestMtimeMs: 0,
    maxFiles: Number(options.maxFiles) || 500,
    maxBytes: Number(options.maxBytes) || 8 * 1024 * 1024,
  };
  collectExtensionTextFiles(deps, state, rootDir);
  return { files: state.files, latestMtimeMs: state.latestMtimeMs, fileCount: state.files.length };
}

function scanExtensionCompatNeeds(deps, rootDir) {
  const scan = listExtensionTextFiles(deps, rootDir);
  const requiredApiRoots = new Set();
  for (const filePath of scan.files) collectRequiredApiRoots(deps.fs, filePath, requiredApiRoots);
  return { ...scan, requiredApiRoots: Array.from(requiredApiRoots).sort(), needsCompatShim: requiredApiRoots.size > 0 };
}

function collectRequiredApiRoots(fs, filePath, requiredApiRoots) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    for (const match of text.matchAll(/\b(?:chrome|browser)\.(windows|tabs|cookies|downloads|alarms|action|storage)\b/g)) {
      requiredApiRoots.add(match[1]);
    }
  } catch (_) {}
}

function createExtensionFileUtils(deps) {
  return {
    copyDirectoryRecursive: (source, target) => copyDirectoryRecursive(deps, source, target),
    isPathInside: (parent, child) => isPathInside(deps.path, parent, child),
    listExtensionTextFiles: (root, options) => listExtensionTextFiles(deps, root, options),
    resolveCompatCacheRoot: () => resolveCompatCacheRoot(deps),
    scanExtensionCompatNeeds: (root) => scanExtensionCompatNeeds(deps, root),
    toSafeFileName,
  };
}

module.exports = { createExtensionFileUtils };
