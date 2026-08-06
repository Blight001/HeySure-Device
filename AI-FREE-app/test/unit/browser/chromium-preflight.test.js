'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runChromiumPreflight } = require('../../../src/app/main/browser-runtime/chromium-preflight');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex').toUpperCase();
}

function createRuntime(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-preflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executablePath = path.join(root, 'ai-free-browser.exe');
  fs.writeFileSync(executablePath, 'browser-runtime');
  fs.writeFileSync(path.join(root, 'runtime-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    files: {
      'ai-free-browser.exe': {
        size: Buffer.byteLength('browser-runtime'),
        sha256: sha256('browser-runtime'),
      },
    },
  }));
  return { root, executablePath };
}

function windowsOptions(executablePath) {
  return {
    executablePath,
    sandboxAccess: { ok: true },
    platform: 'win32',
    arch: 'x64',
    osRelease: '10.0.19045',
    env: { SystemRoot: 'C:\\Windows' },
    spawnSync: () => ({ status: 0, stdout: 'File System Name : NTFS' }),
  };
}

test('Chromium 启动前验证 Windows、NTFS、关键文件哈希和沙箱 ACL', (t) => {
  const runtime = createRuntime(t);
  const result = runChromiumPreflight(windowsOptions(runtime.executablePath));

  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.map((item) => item.status), [
    'passed', 'passed', 'passed', 'passed', 'passed',
  ]);
});

test('关键文件哈希不匹配时启动前自检失败', (t) => {
  const runtime = createRuntime(t);
  fs.writeFileSync(runtime.executablePath, 'tampered-browser-runtime');
  const result = runChromiumPreflight(windowsOptions(runtime.executablePath));

  assert.equal(result.ok, false);
  assert.equal(result.checks.find((item) => item.id === 'runtime-integrity').status, 'failed');
});

test('非 NTFS 安装盘不会继续进入 Chromium 启动', (t) => {
  const runtime = createRuntime(t);
  const options = windowsOptions(runtime.executablePath);
  options.spawnSync = () => ({ status: 0, stdout: 'File System Name : exFAT' });
  const result = runChromiumPreflight(options);

  assert.equal(result.ok, false);
  assert.equal(result.checks.find((item) => item.id === 'filesystem').status, 'failed');
});

test('启动前标记最近命中浏览器文件的 Code Integrity 事件', (t) => {
  const runtime = createRuntime(t);
  const options = windowsOptions(runtime.executablePath);
  options.spawnSync = (_command, args) => (
    args[0] === 'fsinfo'
      ? { status: 0, stdout: 'File System Name : NTFS' }
      : { status: 0, stdout: 'Blocked C:\\Program Files\\AI-FREE\\ai-free-browser.exe' }
  );
  const result = runChromiumPreflight(options);

  assert.equal(result.ok, true);
  assert.equal(result.checks.find((item) => item.id === 'code-integrity').status, 'warning');
});
