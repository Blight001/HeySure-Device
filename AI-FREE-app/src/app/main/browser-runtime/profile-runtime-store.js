const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canTransition, createRuntimeState, normalizeBounds } = require('./runtime-types');

function normalizeProfileId(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized === '.' || normalized === '..') {
    throw new Error('无效的 Profile ID');
  }
  return normalized;
}

// 旧版本只做字符替换，不同业务 ID 可能得到同一个目录名。仅用于迁移。
function legacySafeProfileId(value) {
  return normalizeProfileId(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function safeProfileId(value) {
  const raw = normalizeProfileId(value);
  const legacyId = legacySafeProfileId(raw);
  if (raw === legacyId && raw.length <= 96) return raw;
  const readablePrefix = legacyId.replace(/^_+|_+$/g, '').slice(0, 72) || 'profile';
  const digest = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
  return `${readablePrefix}--${digest}`;
}

class ProfileRuntimeStore {
  constructor(options = {}) {
    this.rootDir = path.resolve(String(options.rootDir || 'chromium-profiles'));
    this.downloadsDir = options.downloadsDir ? path.resolve(String(options.downloadsDir)) : '';
    this.logger = options.logger || console;
    this.states = new Map();
    this.locks = new Map();
  }

  getPathsForStorageId(storageId) {
    const id = String(storageId || '').trim();
    if (!id || id === '.' || id === '..') throw new Error('无效的 Profile 存储 ID');
    const root = path.join(this.rootDir, id);
    return {
      id,
      root,
      config: path.join(root, 'profile.json'),
      chromiumData: path.join(root, 'chromium-data'),
      extensions: path.join(root, 'extensions.json'),
      proxy: path.join(root, 'proxy.enc'),
      fingerprint: path.join(root, 'fingerprint.json'),
      downloads: this.downloadsDir || path.join(root, 'downloads'),
      crashpad: path.join(root, 'crashpad'),
      logs: path.join(root, 'logs'),
      lock: path.join(root, '.runtime.lock'),
    };
  }

  getProfilePaths(profileId) {
    return this.getPathsForStorageId(safeProfileId(profileId));
  }

  getLegacyProfilePaths(profileId) {
    return this.getPathsForStorageId(legacySafeProfileId(profileId));
  }

  migrateLegacyProfile(profileId) {
    const paths = this.getProfilePaths(profileId);
    const legacyPaths = this.getLegacyProfilePaths(profileId);
    if (paths.root === legacyPaths.root || fs.existsSync(paths.root) || !fs.existsSync(legacyPaths.root)) {
      return paths;
    }

    if (fs.existsSync(legacyPaths.lock)) {
      let lock = {};
      try { lock = JSON.parse(fs.readFileSync(legacyPaths.lock, 'utf8')); } catch (_) {}
      const pid = Number(lock.pid || 0);
      if (pid > 0) {
        try {
          process.kill(pid, 0);
          throw new Error(`旧版 Profile ${legacyPaths.id} 仍被进程 ${pid} 使用，暂不能迁移`);
        } catch (error) {
          if (!error || error.code !== 'ESRCH') throw error;
        }
      }
      try { fs.unlinkSync(legacyPaths.lock); } catch (_) {}
    }

    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.renameSync(legacyPaths.root, paths.root);
    this.logger?.log?.(`[ChromiumProfile] 已迁移旧版目录: ${legacyPaths.id} -> ${paths.id}`);
    return paths;
  }

  ensureProfile(profile = {}) {
    const businessProfileId = normalizeProfileId(profile.profileId || profile.id);
    const paths = this.migrateLegacyProfile(businessProfileId);
    for (const dir of [paths.root, paths.chromiumData, paths.downloads, paths.crashpad, paths.logs]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const previous = this.readProfile(businessProfileId);
    const config = {
      profileId: businessProfileId,
      storageId: paths.id,
      runtimeType: 'chromium',
      createdAt: previous.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      displayName: String(profile.displayName || previous.displayName || '').trim(),
    };
    fs.writeFileSync(paths.config, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    return { ...paths, config: paths.config, profile: config };
  }

  readProfile(profileId) {
    const paths = this.getProfilePaths(profileId);
    const legacyPaths = this.getLegacyProfilePaths(profileId);
    const configPath = fs.existsSync(paths.config) ? paths.config : legacyPaths.config;
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (_) {
      return {};
    }
  }

  acquireLock(profileId, metadata = {}) {
    const paths = this.ensureProfile({ profileId });
    if (this.locks.has(paths.id)) return this.locks.get(paths.id);
    let fd;
    try {
      fd = fs.openSync(paths.lock, 'wx');
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let lock = {};
      try { lock = JSON.parse(fs.readFileSync(paths.lock, 'utf8')); } catch (_) {}
      const pid = Number(lock.pid || 0);
      let alive = false;
      if (pid > 0) {
        try { process.kill(pid, 0); alive = true; } catch (_) {}
      }
      if (alive) throw new Error(`Profile ${paths.id} 已被进程 ${pid} 使用`);
      try { fs.unlinkSync(paths.lock); } catch (_) {}
      fd = fs.openSync(paths.lock, 'wx');
    }
    const lockData = { pid: process.pid, acquiredAt: Date.now(), ...metadata };
    fs.writeFileSync(fd, JSON.stringify(lockData), 'utf8');
    const lock = { fd, path: paths.lock, profileId: paths.id };
    this.locks.set(paths.id, lock);
    return lock;
  }

  releaseLock(profileId) {
    const id = safeProfileId(profileId);
    const lock = this.locks.get(id);
    if (!lock) return false;
    try { fs.closeSync(lock.fd); } catch (_) {}
    try { fs.unlinkSync(lock.path); } catch (_) {}
    this.locks.delete(id);
    return true;
  }

  createState(profileId, runtimeType, patch = {}) {
    const businessProfileId = normalizeProfileId(profileId);
    const id = safeProfileId(businessProfileId);
    const state = createRuntimeState(businessProfileId, runtimeType, patch);
    this.states.set(id, state);
    return state;
  }

  getState(profileId) {
    return this.states.get(safeProfileId(profileId)) || null;
  }

  patchState(profileId, patch = {}) {
    const id = safeProfileId(profileId);
    const current = this.states.get(id);
    if (!current) throw new Error(`Profile ${id} 没有运行状态`);
    const next = { ...current, ...patch };
    if (patch.bounds) next.bounds = normalizeBounds(patch.bounds);
    this.states.set(id, next);
    return next;
  }

  transition(profileId, status, patch = {}) {
    const current = this.getState(profileId);
    if (!current) throw new Error(`Profile ${profileId} 没有运行状态`);
    if (!canTransition(current.status, status)) {
      throw new Error(`非法运行时状态迁移: ${current.status} -> ${status}`);
    }
    return this.patchState(profileId, { ...patch, status });
  }

  listStates() {
    return Array.from(this.states.values()).map((state) => ({ ...state }));
  }

  listProfiles() {
    let entries = [];
    try {
      entries = fs.readdirSync(this.rootDir, { withFileTypes: true });
    } catch (_) {
      return [];
    }
    return entries.filter((entry) => entry.isDirectory()).map((entry) => {
      const paths = this.getPathsForStorageId(entry.name);
      let config = {};
      let stat = null;
      try { config = JSON.parse(fs.readFileSync(paths.config, 'utf8')); } catch (_) {}
      try { stat = fs.statSync(paths.root); } catch (_) {}
      return {
        storageId: entry.name,
        profileId: String(config?.profileId || '').trim(),
        displayName: String(config?.displayName || '').trim(),
        createdAt: String(config?.createdAt || '').trim(),
        updatedAt: String(config?.updatedAt || '').trim(),
        lastModifiedAt: Number(stat?.mtimeMs || 0),
      };
    });
  }

  auditProfiles(referencedProfileIds = []) {
    const referencedStorageIds = new Set();
    for (const rawId of referencedProfileIds) {
      const profileId = String(rawId || '').trim();
      if (!profileId) continue;
      try {
        referencedStorageIds.add(safeProfileId(profileId));
        referencedStorageIds.add(legacySafeProfileId(profileId));
      } catch (_) {}
    }
    const profiles = this.listProfiles();
    const orphanProfiles = profiles.filter((profile) => !referencedStorageIds.has(profile.storageId));
    return {
      totalCount: profiles.length,
      referencedCount: profiles.length - orphanProfiles.length,
      orphanCount: orphanProfiles.length,
      orphanProfiles,
    };
  }

  clearState(profileId) {
    return this.states.delete(safeProfileId(profileId));
  }

  clearBrowserData(profileId) {
    const id = safeProfileId(profileId);
    if (this.locks.has(id)) throw new Error(`Profile ${id} 仍在运行，不能清空数据`);
    const paths = this.getProfilePaths(profileId);
    const targets = [
      paths.chromiumData,
      path.join(paths.root, 'session-recovery-stable'),
      path.join(paths.root, 'session-recovery-discarded'),
    ];
    for (const target of targets) {
      const relative = path.relative(paths.root, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Profile 数据清理路径越界');
      }
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    fs.mkdirSync(paths.chromiumData, { recursive: true });
    return true;
  }

  deleteProfile(profileId) {
    const id = safeProfileId(profileId);
    if (this.locks.has(id)) throw new Error(`Profile ${id} 仍在运行，不能删除`);
    const paths = this.getProfilePaths(id);
    const legacyPaths = this.getLegacyProfilePaths(profileId);
    const targets = new Set([paths.root, legacyPaths.root]);
    for (const target of targets) {
      const relative = path.relative(this.rootDir, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Profile 删除路径越界');
      const lockPath = path.join(target, '.runtime.lock');
      if (fs.existsSync(lockPath)) {
        let lock = {};
        try { lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (_) {}
        const pid = Number(lock.pid || 0);
        if (pid > 0) {
          try {
            process.kill(pid, 0);
            throw new Error(`Profile ${path.basename(target)} 仍被进程 ${pid} 使用，不能删除`);
          } catch (error) {
            if (!error || error.code !== 'ESRCH') throw error;
          }
        }
      }
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    this.states.delete(id);
    return true;
  }

  async deleteProfileAsync(profileId) {
    const id = safeProfileId(profileId);
    if (this.locks.has(id)) throw new Error(`Profile ${id} 仍在运行，不能删除`);
    const paths = this.getProfilePaths(id);
    const legacyPaths = this.getLegacyProfilePaths(profileId);
    const targets = new Set([paths.root, legacyPaths.root]);
    for (const target of targets) {
      const relative = path.relative(this.rootDir, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Profile 删除路径越界');
      const lockPath = path.join(target, '.runtime.lock');
      if (fs.existsSync(lockPath)) {
        let lock = {};
        try { lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (_) {}
        const pid = Number(lock.pid || 0);
        if (pid > 0) {
          try {
            process.kill(pid, 0);
            throw new Error(`Profile ${path.basename(target)} 仍被进程 ${pid} 使用，不能删除`);
          } catch (error) {
            if (!error || error.code !== 'ESRCH') throw error;
          }
        }
      }
      // Chromium Profile 通常包含大量缓存小文件。异步递归删除放到
      // libuv 工作线程执行，避免长时间阻塞 Electron 主进程和界面事件。
      await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    this.states.delete(id);
    return true;
  }
}

module.exports = { ProfileRuntimeStore, legacySafeProfileId, safeProfileId };
