'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createChromiumDiagnosticBundle,
} = require('../../../src/app/main/browser-runtime/chromium-diagnostic-bundle');

test('Chromium 失败自动生成单文件脱敏诊断包', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-bundle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logFilePath = path.join(root, 'user-data', 'logs', 'chromium-runtime.log');
  fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
  fs.writeFileSync(
    logFilePath,
    '--hs-runtime-token=private-token Authorization: Bearer private-auth\n',
  );

  const bundlePath = createChromiumDiagnosticBundle({
    diagnosticDir: path.join(root, 'user-data', 'diagnostics'),
    userDataDir: path.join(root, 'user-data'),
    homeDir: root,
    tempDir: path.join(root, 'temp'),
    logFilePath,
    executablePath: path.join(root, 'install', 'ai-free-browser.exe'),
    args: ['--hs-runtime-token=private-token'],
    failure: { reason: 'token=private-reason' },
    platform: 'linux',
    now: () => new Date('2026-07-26T12:00:00.000Z'),
    schedule: (callback) => callback(),
  });

  const content = fs.readFileSync(bundlePath, 'utf8');
  const bundle = JSON.parse(content);
  assert.equal(bundle.schemaVersion, 1);
  assert.match(content, /<redacted>/);
  assert.match(content, /<user-home>/);
  assert.doesNotMatch(content, /private-token|private-auth|private-reason/);
  assert.deepEqual(bundle.windowsEvents, []);
});
