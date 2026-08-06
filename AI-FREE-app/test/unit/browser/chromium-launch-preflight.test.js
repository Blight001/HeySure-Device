'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  prepareChromiumPreflight,
} = require('../../../src/app/main/browser-runtime/chromium-launch-preflight');

test('启动前发现关键文件损坏时阻止启动并生成诊断包', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-preflight-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, 'runtime');
  const executablePath = path.join(runtimeDir, 'ai-free-browser.exe');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(executablePath, 'tampered-runtime');
  fs.writeFileSync(path.join(runtimeDir, 'runtime-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    files: {
      'ai-free-browser.exe': {
        size: 1,
        sha256: '00',
      },
    },
  }));

  assert.throws(
    () => prepareChromiumPreflight({
      chromiumDiagnosticDir: path.join(root, 'diagnostics'),
      chromiumUserDataDir: root,
      chromiumLogPath: path.join(root, 'logs', 'chromium-runtime.log'),
      appVersion: 'test',
    }, executablePath, { ok: true }),
    (error) => {
      assert.equal(error.code, 'CHROMIUM_PREFLIGHT_FAILED');
      assert.ok(fs.existsSync(error.diagnosticBundlePath));
      assert.match(error.message, /runtime-integrity=failed/);
      return true;
    },
  );
});
