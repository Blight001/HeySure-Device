'use strict';

const fs = require('fs');
const path = require('path');
const { findProfileIdByProcessId } = require('./runtime-input');

const MAX_SELECTION_PATHS = 32;
const FILE_SELECTION_MODES = new Set(['open', 'open-multiple', 'upload-folder']);

function selectionError(code, message) {
  const error = /** @type {Error & {code?: string}} */ (new Error(message));
  error.code = code;
  return error;
}

function normalizeOrigin(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); } catch (_) {
    throw selectionError('FILE_SELECTION_ORIGIN_INVALID', '文件上传需要当前页面的有效 HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw selectionError('FILE_SELECTION_ORIGIN_INVALID', '文件上传只允许 HTTP(S) 页面');
  }
  return parsed.origin;
}

function normalizePaths(source = {}) {
  const values = Array.isArray(source.paths) ? source.paths : [source.path].filter(Boolean);
  if (!values.length || values.length > MAX_SELECTION_PATHS) {
    throw selectionError('FILE_SELECTION_COUNT_INVALID', '文件上传需要 1-32 个本地路径');
  }
  return values.map((value) => {
    const candidate = String(value || '').trim();
    if (!candidate || !path.isAbsolute(candidate)) {
      throw selectionError('FILE_SELECTION_PATH_INVALID', '文件上传路径必须是绝对路径');
    }
    return path.normalize(candidate);
  });
}

function resolveMode(source, paths) {
  const requested = String(source.mode || '').trim();
  const mode = requested || (paths.length > 1 ? 'open-multiple' : 'open');
  if (!FILE_SELECTION_MODES.has(mode)) {
    throw selectionError('FILE_SELECTION_MODE_INVALID', '文件上传模式无效');
  }
  if (mode !== 'open-multiple' && paths.length !== 1) {
    throw selectionError('FILE_SELECTION_COUNT_INVALID', '当前文件上传模式只允许一个路径');
  }
  return mode;
}

function realPathOrResolved(candidate) {
  try { return fs.realpathSync.native(candidate); } catch (_) { return path.resolve(candidate); }
}

function assertPathsInSandbox(paths, sandboxDir) {
  if (!sandboxDir) return;
  const root = realPathOrResolved(String(sandboxDir));
  for (const candidate of paths) {
    const relative = path.relative(root, realPathOrResolved(candidate));
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw selectionError('FILE_SELECTION_OUTSIDE_SANDBOX', `只能上传 AI 工作区内的文件: ${root}`);
    }
  }
}

async function validatePathTypes(paths, mode) {
  for (const candidate of paths) {
    let stats;
    try { stats = await fs.promises.stat(candidate); } catch (_) {
      throw selectionError('FILE_SELECTION_PATH_NOT_FOUND', `本地路径不存在: ${candidate}`);
    }
    const valid = mode === 'upload-folder' ? stats.isDirectory() : stats.isFile();
    if (!valid) {
      const expected = mode === 'upload-folder' ? '目录' : '文件';
      throw selectionError('FILE_SELECTION_PATH_TYPE_INVALID', `本地路径不是${expected}: ${candidate}`);
    }
  }
}

async function prepareRuntimeFileSelection(source = {}, options = {}) {
  const paths = normalizePaths(source);
  assertPathsInSandbox(paths, options.sandboxDir);
  const mode = resolveMode(source, paths);
  await validatePathTypes(paths, mode);
  return {
    origin: normalizeOrigin(source.pageUrl || source.origin),
    paths,
    mode,
    ttlMs: Math.min(120000, Math.max(1000, Number(source.ttlMs) || 30000)),
  };
}

async function selectRuntimeFiles(runtime, profileId, source, options = {}) {
  const selection = await prepareRuntimeFileSelection(source, options);
  return runtime.enqueueProfileOperation(profileId, () => (
    runtime.getReadyInstance(profileId).commandClient.send('select-files', selection)
  ));
}

async function selectRuntimeFilesByProcessId(runtime, processId, source, options = {}) {
  const profileId = findProfileIdByProcessId(runtime.instances, processId);
  if (profileId) return selectRuntimeFiles(runtime, profileId, source, options);
  throw selectionError(
    'CHROMIUM_PROCESS_NOT_MANAGED',
    `Chromium 进程 ${Number(processId || 0) || '<empty>'} 不属于当前受管 Profile`,
  );
}

module.exports = {
  FILE_SELECTION_MODES,
  MAX_SELECTION_PATHS,
  assertPathsInSandbox,
  normalizeOrigin,
  normalizePaths,
  prepareRuntimeFileSelection,
  resolveMode,
  selectRuntimeFiles,
  selectRuntimeFilesByProcessId,
};
