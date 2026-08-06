const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { appContext } = require('../../runtime/app-context');
const { BrowserWindow, shell, app: electronApp } = require('electron');
const extractZip = require('extract-zip');
const tar = require('tar');
const { compareVersions } = require('../../../shared/version-utils');
const { summarizeUpdatePayload } = require('../../utils/update-payload');
const { toDebugString } = require('./update-notice');

// 处理：firstNonEmpty的具体业务逻辑。
function safeMkdir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

// 停止/关闭/清理：clearDirectory的具体业务逻辑。
function clearDirectory(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return;
    if (fs.rmSync) {
      fs.rmSync(dirPath, { recursive: true, force: true });
      return;
    }
    fs.rmdirSync(dirPath, { recursive: true });
  } catch (_) {}
}

// 停止/关闭/清理：cleanupUpdateStorageRoot的具体业务逻辑。
function cleanupUpdateStorageRoot(dirPath = null, logger = console) {
  const targets = [];
  const pushTarget = (value) => {
    const target = String(value || '').trim();
    if (target && !targets.includes(target)) {
      targets.push(target);
    }
  };

  if (dirPath) {
    pushTarget(dirPath);
  } else {
    pushTarget(getUpdateStorageRoot());
    pushTarget(getLegacyUpdateStorageRoot());
  }

  if (targets.length === 0) {
    throw new Error('更新缓存目录为空');
  }

  const results = [];
  for (const target of targets) {
    try {
      if (!fs.existsSync(target)) {
        results.push({ target, ok: true, removed: false });
        continue;
      }

      if (fs.rmSync) {
        fs.rmSync(target, { recursive: true, force: true });
      } else {
        fs.rmdirSync(target, { recursive: true });
      }

      logger.warn?.('[更新] 已清理更新缓存目录', toDebugString({ target }));
      results.push({ target, ok: true, removed: true });
    } catch (error) {
      logger.warn?.('[更新] 清理更新缓存目录失败:', error?.message || error);
      results.push({ target, ok: false, removed: false, message: error?.message || String(error) });
    }
  }

  return {
    ok: results.every((item) => item.ok !== false),
    results,
  };
}

// 处理：isArchiveFile的具体业务逻辑。
function isArchiveFile(filePath) {
  const lower = String(filePath || '').toLowerCase();
  return lower.endsWith('.zip') || lower.endsWith('.tar') || lower.endsWith('.tgz') || lower.endsWith('.tar.gz');
}

// 处理：isExecutableCandidate的具体业务逻辑。
function isExecutableCandidate(filePath) {
  const lower = String(filePath || '').toLowerCase();
  return lower.endsWith('.exe') || lower.endsWith('.cmd') || lower.endsWith('.bat') || lower.endsWith('.ps1');
}

// 获取/读取/解析：findLaunchTarget的具体业务逻辑。
async function findLaunchTarget(dirPath, entryFile = '') {
  const normalizedEntry = String(entryFile || '').trim();
  if (normalizedEntry) {
    const directPath = path.isAbsolute(normalizedEntry)
      ? normalizedEntry
      : path.join(dirPath, normalizedEntry);
    if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) {
      return directPath;
    }
  }

// 处理：walk的具体业务逻辑。
  const walk = (currentDir) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        const nested = walk(fullPath);
        if (nested) return nested;
        continue;
      }
      if (isExecutableCandidate(fullPath)) {
        return fullPath;
      }
    }
    return '';
  };

  const directExe = walk(dirPath);
  if (directExe) return directExe;

  const files = fs.readdirSync(dirPath, { withFileTypes: true }).filter((entry) => entry.isFile());
  if (files.length === 1) {
    return path.join(dirPath, files[0].name);
  }

  return '';
}

// 处理：downloadFile的具体业务逻辑。
function downloadFile(urlString, destination, progressCallback, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const maxRedirects = 5;
    const handler = urlString.startsWith('https:') ? https : http;
    const request = handler.get(urlString, {
      headers: { Accept: '*/*' },
      rejectUnauthorized: false,
    }, (response) => {
      const statusCode = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode) && response.headers.location) {
        if (redirectCount >= maxRedirects) {
          reject(new Error('下载链接重定向次数过多'));
          return;
        }
        const nextUrl = new URL(response.headers.location, urlString).toString();
        response.resume();
        resolve(downloadFile(nextUrl, destination, progressCallback, redirectCount + 1));
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        reject(new Error(`下载失败，HTTP 状态码 ${statusCode}`));
        response.resume();
        return;
      }

      safeMkdir(path.dirname(destination));
      const total = Number(response.headers['content-length'] || 0);
      let received = 0;
      const writer = fs.createWriteStream(destination);

      response.on('data', (chunk) => {
        received += chunk.length;
        if (typeof progressCallback === 'function') {
          progressCallback({
            phase: 'downloading',
            receivedBytes: received,
            totalBytes: Number.isFinite(total) && total > 0 ? total : null,
            percent: Number.isFinite(total) && total > 0 ? Math.min(99.5, (received / total) * 100) : null,
          });
        }
      });

      response.on('error', (error) => {
        try { writer.destroy(); } catch (_) {}
        reject(error);
      });

      writer.on('error', reject);
      writer.on('finish', () => resolve({
        destination,
        totalBytes: Number.isFinite(total) && total > 0 ? total : null,
      }));
      response.pipe(writer);
    });

    request.setTimeout(30000, () => {
      try { request.destroy(new Error('下载超时')); } catch (_) {}
    });
    request.on('error', reject);
  });
}

// 获取/读取/解析：extractDownloadedPackage的具体业务逻辑。
async function extractDownloadedPackage(sourceFile, targetDir, logger = console) {
  const lower = String(sourceFile || '').toLowerCase();
  safeMkdir(targetDir);
  logger.warn?.('[更新] 开始解压文件', toDebugString({
    sourceFile,
    targetDir,
    lower,
  }));

  if (lower.endsWith('.zip')) {
    await extractZip(sourceFile, { dir: targetDir });
    logger.warn?.('[更新] ZIP 解压完成', toDebugString({ sourceFile, targetDir }));
    return;
  }

  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    await tar.x({ file: sourceFile, cwd: targetDir, gzip: true });
    logger.warn?.('[更新] TAR.GZ/TGZ 解压完成', toDebugString({ sourceFile, targetDir }));
    return;
  }

  if (lower.endsWith('.tar')) {
    await tar.x({ file: sourceFile, cwd: targetDir });
    logger.warn?.('[更新] TAR 解压完成', toDebugString({ sourceFile, targetDir }));
  }

  logger.warn?.('[更新] 解压函数结束', toDebugString({ sourceFile, targetDir }));
}

// 停止/关闭/清理：cleanupDownloadedArchive的具体业务逻辑。
function cleanupDownloadedArchive(filePath, logger = console) {
  const target = String(filePath || '').trim();
  if (!target || !isArchiveFile(target)) {
    return { ok: true, removed: false, target };
  }

  try {
    if (!fs.existsSync(target)) {
      return { ok: true, removed: false, target };
    }

    fs.unlinkSync(target);
    logger.warn?.('[更新] 已删除压缩包文件', toDebugString({ target }));
    return { ok: true, removed: true, target };
  } catch (error) {
    logger.warn?.('[更新] 删除压缩包文件失败:', error?.message || error);
    return { ok: false, removed: false, target, message: error?.message || String(error) };
  }
}

// 处理：copyDirectoryContents的具体业务逻辑。
function copyDirectoryContents(sourceDir, targetDir) {
  safeMkdir(targetDir);
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryContents(sourcePath, targetPath);
      continue;
    }
    if (entry.isSymbolicLink && entry.isSymbolicLink()) {
      try {
        const linkTarget = fs.readlinkSync(sourcePath);
        fs.symlinkSync(linkTarget, targetPath);
      } catch (_) {
        fs.copyFileSync(sourcePath, targetPath);
      }
      continue;
    }
    fs.copyFileSync(sourcePath, targetPath);
  }
}

// 获取/读取/解析：getUpdateStorageRoot的具体业务逻辑。
function getUpdateStorageRoot(pathDep = path, appDep = electronApp) {
  try {
    const baseDir = appDep && typeof appDep.getPath === 'function'
      ? appDep.getPath('userData')
      : pathDep.resolve(process.cwd(), '.user-data');
    return pathDep.resolve(baseDir, 'ai-free-update');
  } catch (_) {
    return pathDep.resolve(process.cwd(), '.user-data', 'ai-free-update');
  }
}

// 获取/读取/解析：getLegacyUpdateStorageRoot的具体业务逻辑。
function getLegacyUpdateStorageRoot(pathDep = path) {
  return pathDep.resolve(process.cwd(), 'src', 'assets', 'ai-free-update');
}

function getExecutableLaunchSpec(target) {
  const ext = path.extname(target).toLowerCase();
  const commandByExtension = { '.bat': 'cmd.exe', '.cmd': 'cmd.exe', '.ps1': 'powershell.exe' };
  const argsByExtension = {
    '.bat': ['/d', '/s', '/c', 'start', '""', target],
    '.cmd': ['/d', '/s', '/c', 'start', '""', target],
    '.ps1': ['-ExecutionPolicy', 'Bypass', '-File', target],
  };
  return {
    target,
    ext,
    cwd: path.dirname(target),
    command: commandByExtension[ext] || target,
    args: argsByExtension[ext] || [],
    useSystemShell: process.platform === 'win32' && ext === '.exe',
  };
}

function spawnDetachedExecutable(spec, logger) {
  const { target, command, args, cwd } = spec;
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore', windowsHide: true });
    const resolveLaunch = (method) => {
      if (settled) return;
      settled = true;
      try { child.unref(); } catch (_) {}
      resolve({ pid: child.pid ?? null, target, method });
    };
    child.once('spawn', () => {
      logger.warn?.('[更新] 启动进程已创建', toDebugString({ pid: child.pid ?? null, target, command, args }));
      resolveLaunch('spawn');
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      logger.error?.('[更新] 启动进程创建失败:', error?.message || error);
      reject(error);
    });
    setTimeout(() => {
      logger.warn?.('[更新] 启动进程未及时回调 spawn，继续按已启动处理', toDebugString({
        target, pid: child.pid ?? null, command, args,
      }));
      resolveLaunch('spawn-timeout');
    }, 2000);
  });
}

// 启动/打开/显示：launchExecutable的具体业务逻辑。
async function launchExecutable(launchTarget, logger = console) {
  const target = String(launchTarget || '').trim();
  if (!target) {
    throw new Error('启动目标为空');
  }

  const spec = getExecutableLaunchSpec(target);
  const { cwd, command, args, useSystemShell } = spec;

  logger.warn?.('[更新] 准备启动文件', toDebugString({
    target,
    cwd,
    command,
    args,
    launchStrategy: useSystemShell ? 'shell.openPath' : 'spawn',
  }));

  if (useSystemShell) {
    const openPathError = await shell.openPath(target);
    if (!openPathError) {
      logger.warn?.('[更新] 系统 shell 已启动文件', toDebugString({
        target,
        cwd,
      }));
      return { pid: null, target, method: 'shell.openPath' };
    }

    logger.warn?.('[更新] 系统 shell 启动失败，回退到 spawn', toDebugString({
      target,
      error: openPathError,
    }));
  }

  return spawnDetachedExecutable(spec, logger);
}

// 创建/初始化：createAppUpdater的具体业务逻辑。

module.exports = {
  safeMkdir,
  clearDirectory,
  cleanupUpdateStorageRoot,
  isArchiveFile,
  isExecutableCandidate,
  findLaunchTarget,
  downloadFile,
  extractDownloadedPackage,
  cleanupDownloadedArchive,
  copyDirectoryContents,
  getUpdateStorageRoot,
  getLegacyUpdateStorageRoot,
  launchExecutable,
};
