'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createChromiumLaunchLog } = require('../../../src/app/main/browser-runtime/chromium-launch-log');

test('Chromium 独立启动日志记录环境并清理启动 token 和代理凭据', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-chromium-log-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const logFilePath = path.join(tempRoot, 'logs', 'chromium-runtime.log');
  const log = createChromiumLaunchLog({
    logFilePath,
    now: () => new Date('2026-07-26T12:00:00.000Z'),
  });

  log.writeLaunch({
    executablePath: 'C:\\AI-FREE\\resources\\chromium\\ai-free-browser.exe',
    pid: 1234,
    sandboxAccess: { ok: false, status: 5, error: 'Access is denied' },
    args: [
      '--hs-runtime-token=secret-token',
      '--proxy-server=http://user:password@127.0.0.1:7890',
      '--user-data-dir=C:\\Profiles\\profile-a',
    ],
  });
  log.writeOutput('stderr', 'Authorization: Bearer private-value');

  const content = fs.readFileSync(logFilePath, 'utf8');
  assert.match(content, /chromium-launch/);
  assert.match(content, /pid=1234/);
  assert.match(content, /sandbox-access=failed\(status=5, error=Access is denied\)/);
  assert.match(content, /--hs-runtime-token=<redacted>/);
  assert.match(content, /http:\/\/<redacted>@127\.0\.0\.1:7890/);
  assert.match(content, /Authorization: Bearer <redacted>/i);
  assert.doesNotMatch(content, /secret-token|user:password|private-value/);
});

test('Chromium 启动参数默认强制开启 stderr 内核日志', () => {
  const { buildChromiumArgs } = require('../../../src/app/main/browser-runtime/chromium-launcher');
  const args = buildChromiumArgs({
    profile: {},
    paths: { chromiumData: 'profile-data', downloads: 'downloads' },
    pipeName: 'pipe',
    launchToken: 'token',
  });

  assert.ok(args.includes('--enable-logging=stderr'));
});
