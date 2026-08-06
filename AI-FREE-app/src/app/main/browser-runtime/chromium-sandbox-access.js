const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const preparedChromiumSandboxDirs = new Set();

function cacheSignature(executablePath, fileSystem) {
  try {
    const resolved = path.resolve(String(executablePath || ''));
    const stat = fileSystem.statSync(resolved);
    return `${resolved}|${stat.size}|${Math.trunc(stat.mtimeMs)}`;
  } catch (_) {
    return '';
  }
}

function readPersistentCache(cacheFile, signature, fileSystem) {
  if (!cacheFile || !signature) return false;
  try {
    const cached = JSON.parse(fileSystem.readFileSync(cacheFile, 'utf8'));
    return cached && cached.signature === signature;
  } catch (_) {
    return false;
  }
}

function writePersistentCache(cacheFile, signature, fileSystem) {
  if (!cacheFile || !signature) return;
  const target = path.resolve(cacheFile);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    fileSystem.mkdirSync(path.dirname(target), { recursive: true });
    fileSystem.writeFileSync(temporary, `${JSON.stringify({ signature, updatedAt: Date.now() })}\n`, 'utf8');
    fileSystem.renameSync(temporary, target);
  } catch (_) {
    try { fileSystem.rmSync(temporary, { force: true }); } catch (_) {}
  }
}

function writeLog(logger, level, ...args) {
  const output = logger && typeof logger[level] === 'function' ? logger[level] : null;
  if (output) output.call(logger, ...args);
}

function describeFailure(result) {
  if (!result) return 'icacls 未返回执行结果';
  if (result.error) return String(result.error.message || result.error);
  return String(result.stderr || '').trim() || `icacls exit ${result.status}`;
}

function resolveCachedAccess(executablePath, cacheFile, fileSystem) {
  const chromiumDir = path.dirname(path.resolve(String(executablePath || '')));
  const signature = cacheSignature(executablePath, fileSystem);
  const cacheKey = signature || chromiumDir;
  if (preparedChromiumSandboxDirs.has(cacheKey)) {
    return { chromiumDir, signature, cacheKey, result: { ok: true, cached: true } };
  }
  if (readPersistentCache(cacheFile, signature, fileSystem)) {
    preparedChromiumSandboxDirs.add(cacheKey);
    return { chromiumDir, signature, cacheKey, result: { ok: true, persistentCached: true } };
  }
  return { chromiumDir, signature, cacheKey, result: null };
}

function grantSandboxAccess(chromiumDir, env, run) {
  const systemRoot = String(env.SystemRoot || env.WINDIR || 'C:\\Windows');
  return run(path.join(systemRoot, 'System32', 'icacls.exe'), [
    chromiumDir,
    '/grant',
    '*S-1-15-2-1:(OI)(CI)(RX)',
    '*S-1-15-2-2:(OI)(CI)(RX)',
    '/T',
    '/C',
    '/Q',
  ], {
    windowsHide: true,
    encoding: 'utf8',
  });
}

// Chromium 的 Windows 沙箱会用 AppContainer 身份重新读取 exe、DLL 和 pak。
// 部分按用户安装的 NSIS 目录只授权当前用户，导致浏览器主进程能启动，
// Network Service 却因“拒绝访问”崩溃，最终可见页停在 about:blank。
function ensureChromiumSandboxAccess(executablePath, logger = console, {
  platform = process.platform,
  env = process.env,
  cacheFile = '',
  fs: fileSystem = fs,
  spawnSync: run = spawnSync,
} = {}) {
  if (platform !== 'win32') return { ok: true, skipped: true };

  const cache = resolveCachedAccess(executablePath, cacheFile, fileSystem);
  if (cache.result) return cache.result;
  const result = grantSandboxAccess(cache.chromiumDir, env, run);
  if (!result || result.error || result.status !== 0) {
    const detail = describeFailure(result);
    writeLog(logger, 'warn', '[ChromiumRuntime] 修复 Chromium 沙箱读取权限失败:', detail);
    return { ok: false, error: detail, status: result?.status };
  }

  preparedChromiumSandboxDirs.add(cache.cacheKey);
  writePersistentCache(cacheFile, cache.signature, fileSystem);
  writeLog(logger, 'info', '[ChromiumRuntime] Chromium 沙箱读取权限已确认:', cache.chromiumDir);
  return { ok: true };
}

module.exports = { ensureChromiumSandboxAccess };
