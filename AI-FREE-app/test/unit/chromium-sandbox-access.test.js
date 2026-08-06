const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureChromiumSandboxAccess } = require('../../src/app/main/browser-runtime/chromium-launcher');

test('Windows Chromium 目录授予 AppContainer 只读执行权限', () => {
  let invocation = null;
  const result = ensureChromiumSandboxAccess('C:\\AI-FREE\\chromium\\ai-free-browser.exe', console, {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    spawnSync(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(invocation.command, 'C:\\Windows\\System32\\icacls.exe');
  assert.deepEqual(invocation.args.slice(1, 4), [
    '/grant',
    '*S-1-15-2-1:(OI)(CI)(RX)',
    '*S-1-15-2-2:(OI)(CI)(RX)',
  ]);
  assert.ok(invocation.args.includes('/T'));
  assert.equal(invocation.options.windowsHide, true);
});

test('非 Windows 平台不调用 icacls', () => {
  let called = false;
  const result = ensureChromiumSandboxAccess('/opt/ai-free/chromium', console, {
    platform: 'linux',
    spawnSync() {
      called = true;
    },
  });

  assert.deepEqual(result, { ok: true, skipped: true });
  assert.equal(called, false);
});

test('Chromium 版本未变化时跨软件重启复用持久 ACL 结果', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-acl-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const executable = path.join(tempRoot, 'chromium', 'ai-free-browser.exe');
  const cacheFile = path.join(tempRoot, 'profiles', '.chromium-sandbox-access.json');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, 'runtime-v1');
  let calls = 0;
  const options = {
    platform: 'win32', cacheFile, env: { SystemRoot: 'C:\\Windows' },
    spawnSync() { calls += 1; return { status: 0, stdout: '', stderr: '' }; },
  };

  assert.equal(ensureChromiumSandboxAccess(executable, console, options).ok, true);
  const modulePath = require.resolve('../../src/app/main/browser-runtime/chromium-sandbox-access');
  delete require.cache[modulePath];
  const fresh = require(modulePath);
  const cached = fresh.ensureChromiumSandboxAccess(executable, console, options);

  assert.equal(calls, 1);
  assert.equal(cached.persistentCached, true);
});
