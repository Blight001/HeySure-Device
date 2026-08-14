'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MINIMUM_WINDOWS_BUILD = 17763;
const RUNTIME_MANIFEST = 'runtime-manifest.json';
const INTEGRITY_CHANNELS = [
  'Microsoft-Windows-CodeIntegrity/Operational',
  'Microsoft-Windows-AppLocker/EXE and DLL',
];
const PREFLIGHT_CACHE_LIMIT = 8;
const hashCache = new Map();
const preflightCache = new Map();

function check(id, status, detail, extra = {}) {
  return { id, status, detail: String(detail || ''), ...extra };
}

function windowsBuild(release) {
  const parts = String(release || '').split('.');
  const build = Number(parts[2]);
  return Number.isInteger(build) ? build : 0;
}

function checkPlatform(platform, arch, release) {
  if (platform !== 'win32') return check('platform', 'skipped', `${platform}/${arch}`);
  const build = windowsBuild(release);
  if (arch !== 'x64') return check('platform', 'failed', `需要 Windows x64，当前为 ${arch}`);
  if (build && build < MINIMUM_WINDOWS_BUILD) {
    return check('platform', 'failed', `Windows build ${build} 低于沙箱最低要求 ${MINIMUM_WINDOWS_BUILD}`);
  }
  return check('platform', 'passed', `win32/${arch} build=${build || 'unknown'}`);
}

function parseFileSystem(stdout) {
  const text = String(stdout || '');
  if (/\bNTFS\b/i.test(text)) return 'NTFS';
  const known = text.match(/\b(?:ReFS|exFAT|FAT32|FAT)\b/i);
  return known ? known[0] : '';
}

function checkFileSystem(executablePath, platform, env, run) {
  if (platform !== 'win32') return check('filesystem', 'skipped', platform);
  const systemRoot = String(env.SystemRoot || env.WINDIR || 'C:\\Windows');
  const volume = path.parse(path.resolve(executablePath)).root;
  const result = run(
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command',
      '[IO.DriveInfo]::new($env:AI_FREE_PREFLIGHT_VOLUME).DriveFormat'],
    {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 3000,
      env: { ...env, AI_FREE_PREFLIGHT_VOLUME: volume },
    },
  );
  if (!result || result.error || result.status !== 0) {
    return check('filesystem', 'warning', `无法读取 ${volume} 文件系统`);
  }
  const format = parseFileSystem(result.stdout);
  if (!format) return check('filesystem', 'warning', `${volume} 文件系统类型未知`);
  return check('filesystem', format === 'NTFS' ? 'passed' : 'failed', `${volume} ${format}`);
}

function checkCodeIntegrity(executablePath, platform, env, run) {
  if (platform !== 'win32') return check('code-integrity', 'skipped', platform);
  const systemRoot = String(env.SystemRoot || env.WINDIR || 'C:\\Windows');
  const executableName = path.basename(executablePath).toLowerCase();
  const matchedChannels = [];
  let readableChannels = 0;
  for (const channel of INTEGRITY_CHANNELS) {
    const result = run(path.join(systemRoot, 'System32', 'wevtutil.exe'), [
      'qe', channel,
      '/q:*[System[TimeCreated[timediff(@SystemTime) <= 900000]]]',
      '/c:20', '/rd:true', '/f:text',
    ], { windowsHide: true, encoding: 'utf8', timeout: 1500 });
    if (result?.status !== 0) continue;
    readableChannels += 1;
    if (String(result.stdout || '').toLowerCase().includes(executableName)) {
      matchedChannels.push(channel);
    }
  }
  if (matchedChannels.length) {
    return check('code-integrity', 'warning', `最近事件命中: ${matchedChannels.join(', ')}`);
  }
  return readableChannels
    ? check('code-integrity', 'passed', `已检查 ${readableChannels} 个事件通道`)
    : check('code-integrity', 'warning', 'Code Integrity/AppLocker 事件通道不可读');
}

function readManifest(runtimeDir, fileSystem) {
  const manifestPath = path.join(runtimeDir, RUNTIME_MANIFEST);
  try {
    const parsed = JSON.parse(fileSystem.readFileSync(manifestPath, 'utf8'));
    if (parsed?.schemaVersion !== 1 || !parsed.files || typeof parsed.files !== 'object') {
      throw new Error('manifest schema invalid');
    }
    return { manifestPath, manifest: parsed };
  } catch (error) {
    return { manifestPath, error: error?.code || error?.message || String(error) };
  }
}

function sha256(filePath, stat, fileSystem) {
  const signature = [
    filePath,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
    stat.ino || 0,
  ].join('|');
  if (hashCache.has(signature)) return hashCache.get(signature);
  const digest = crypto.createHash('sha256')
    .update(fileSystem.readFileSync(filePath))
    .digest('hex')
    .toUpperCase();
  hashCache.set(signature, digest);
  return digest;
}

function checkRuntimeFiles(executablePath, fileSystem) {
  const runtimeDir = path.dirname(path.resolve(executablePath));
  const loaded = readManifest(runtimeDir, fileSystem);
  if (!loaded.manifest) {
    return check('runtime-integrity', 'warning', `缺少可信哈希清单: ${loaded.error}`, {
      manifestPath: loaded.manifestPath,
    });
  }
  const failures = [];
  let verified = 0;
  for (const [relativePath, expected] of Object.entries(loaded.manifest.files)) {
    const filePath = path.join(runtimeDir, relativePath);
    try {
      const stat = fileSystem.statSync(filePath);
      const actualHash = sha256(filePath, stat, fileSystem);
      if (Number(expected.size) !== stat.size || String(expected.sha256).toUpperCase() !== actualHash) {
        failures.push(relativePath);
      } else {
        verified += 1;
      }
    } catch (_) {
      failures.push(relativePath);
    }
  }
  return check(
    'runtime-integrity',
    failures.length ? 'failed' : 'passed',
    failures.length ? `损坏或缺失: ${failures.join(', ')}` : `已验证 ${verified} 个关键文件`,
    { manifestPath: loaded.manifestPath, verified, failures },
  );
}

function checkSandbox(sandboxAccess) {
  if (sandboxAccess?.ok) {
    const mode = sandboxAccess.skipped ? 'skipped' : 'ACL verified';
    return check('sandbox-access', 'passed', mode);
  }
  return check('sandbox-access', 'failed', sandboxAccess?.error || 'AppContainer ACL 检查失败');
}

function statSignature(filePath, fileSystem) {
  try {
    const stat = fileSystem.statSync(filePath);
    return [
      stat.size,
      stat.mtimeMs,
      stat.ctimeMs,
      stat.ino || 0,
    ].join(':');
  } catch (error) {
    return `missing:${error?.code || 'unknown'}`;
  }
}

function runtimeSignature(executablePath, fileSystem) {
  const runtimeDir = path.dirname(path.resolve(executablePath));
  const manifestPath = path.join(runtimeDir, RUNTIME_MANIFEST);
  let manifestBytes;
  let relativePaths = [];
  try {
    manifestBytes = fileSystem.readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    relativePaths = Object.keys(manifest?.files || {}).sort();
  } catch (_) {
    manifestBytes = Buffer.alloc(0);
  }
  const parts = [
    path.resolve(executablePath),
    crypto.createHash('sha256').update(manifestBytes).digest('hex'),
    statSignature(manifestPath, fileSystem),
  ];
  for (const relativePath of relativePaths) {
    parts.push(relativePath, statSignature(path.join(runtimeDir, relativePath), fileSystem));
  }
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

function cacheKey(options, fileSystem) {
  const platform = options.platform || process.platform;
  const sandboxAccess = options.sandboxAccess || {};
  return JSON.stringify({
    runtime: runtimeSignature(options.executablePath, fileSystem),
    platform,
    arch: options.arch || process.arch,
    release: options.osRelease || os.release(),
    systemRoot: platform === 'win32'
      ? String((options.env || process.env).SystemRoot || (options.env || process.env).WINDIR || '')
      : '',
    sandboxAccess: {
      ok: Boolean(sandboxAccess.ok),
      skipped: Boolean(sandboxAccess.skipped),
      error: sandboxAccess.ok ? '' : String(sandboxAccess.error || ''),
    },
  });
}

function rememberPreflight(key, result) {
  if (preflightCache.size >= PREFLIGHT_CACHE_LIMIT) {
    preflightCache.delete(preflightCache.keys().next().value);
  }
  preflightCache.set(key, result);
}

function formatChromiumPreflight(result) {
  return result.checks.map((item) => `${item.id}=${item.status}(${item.detail})`).join('; ');
}

function runChromiumPreflight(options = {}) {
  const platform = options.platform || process.platform;
  const checks = [
    checkPlatform(platform, options.arch || process.arch, options.osRelease || os.release()),
    checkFileSystem(
      options.executablePath,
      platform,
      options.env || process.env,
      options.spawnSync || spawnSync,
    ),
    checkCodeIntegrity(
      options.executablePath,
      platform,
      options.env || process.env,
      options.spawnSync || spawnSync,
    ),
    checkRuntimeFiles(options.executablePath, options.fs || fs),
    checkSandbox(options.sandboxAccess),
  ];
  return {
    ok: !checks.some((item) => item.status === 'failed'),
    checkedAt: new Date().toISOString(),
    checks,
  };
}

function runCachedChromiumPreflight(options = {}) {
  const fileSystem = options.fs || fs;
  const key = cacheKey(options, fileSystem);
  const cached = preflightCache.get(key);
  if (cached) return cached;
  const result = runChromiumPreflight(options);
  rememberPreflight(key, result);
  return result;
}

function primeCachedChromiumPreflight(options = {}, result) {
  if (!result || !Array.isArray(result.checks)) return null;
  const fileSystem = options.fs || fs;
  rememberPreflight(cacheKey(options, fileSystem), result);
  return result;
}

module.exports = {
  formatChromiumPreflight,
  primeCachedChromiumPreflight,
  runCachedChromiumPreflight,
  runChromiumPreflight,
};
