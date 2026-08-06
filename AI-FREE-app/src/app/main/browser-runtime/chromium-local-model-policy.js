const fs = require('fs');
const path = require('path');

const LOCAL_MODEL_DIR = 'OptGuideOnDeviceModel';
const DISABLED_LOCAL_MODEL_FEATURES = Object.freeze([
  'OptimizationGuideOnDeviceModel',
  'OnDeviceModelBackgroundDownload',
]);

function featureName(value) {
  return String(value || '').trim().split(/[<:]/, 1)[0];
}

function enforceLocalModelDisabled(args = []) {
  const output = [];
  const disabled = [];
  const blocked = new Set(DISABLED_LOCAL_MODEL_FEATURES);
  for (const rawArg of args) {
    const arg = String(rawArg || '');
    if (arg.startsWith('--disable-features=')) {
      disabled.push(...arg.slice('--disable-features='.length).split(',').filter(Boolean));
      continue;
    }
    if (arg.startsWith('--enable-features=')) {
      const enabled = arg.slice('--enable-features='.length).split(',')
        .filter((item) => item && !blocked.has(featureName(item)));
      if (enabled.length) output.push(`--enable-features=${enabled.join(',')}`);
      continue;
    }
    output.push(arg);
  }
  const combined = [...new Set([...disabled, ...DISABLED_LOCAL_MODEL_FEATURES])];
  output.push(`--disable-features=${combined.join(',')}`);
  return output;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function profileHasLiveLock(profileRoot) {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(profileRoot, '.runtime.lock'), 'utf8'));
    return isProcessAlive(Number(lock.pid));
  } catch (_) {
    return false;
  }
}

async function cleanupProfileLocalModel(profileRoot) {
  if (profileHasLiveLock(profileRoot)) return 'skipped';
  const target = path.resolve(profileRoot, 'chromium-data', LOCAL_MODEL_DIR);
  const relative = path.relative(profileRoot, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return 'skipped';
  try {
    await fs.promises.access(target);
    await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return 'removed';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'absent';
    return 'failed';
  }
}

async function cleanupLocalModels(profileRootDir, logger = console) {
  let entries = [];
  try { entries = await fs.promises.readdir(profileRootDir, { withFileTypes: true }); } catch (_) { return []; }
  const results = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => ({
    profile: entry.name,
    status: await cleanupProfileLocalModel(path.join(profileRootDir, entry.name)),
  })));
  const removed = results.filter((result) => result.status === 'removed').length;
  const failed = results.filter((result) => result.status === 'failed');
  if (removed) logger?.info?.(`[ChromiumRuntime] 已清理 ${removed} 个 Profile 的本地 AI 模型缓存`);
  if (failed.length) logger?.warn?.('[ChromiumRuntime] 部分本地 AI 模型缓存清理失败，将在下次启动重试');
  return results;
}

module.exports = {
  DISABLED_LOCAL_MODEL_FEATURES,
  LOCAL_MODEL_DIR,
  cleanupLocalModels,
  enforceLocalModelDisabled,
};
