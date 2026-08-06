'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  cleanupLocalModels,
  enforceLocalModelDisabled,
} = require('../../../src/app/main/browser-runtime/chromium-local-model-policy');

test('启动参数强制禁用本地模型且不能被自定义 enable-features 覆盖', () => {
  const args = enforceLocalModelDisabled([
    '--enable-features=OptimizationGuideOnDeviceModel,KeepEnabled',
    '--disable-features=AlreadyDisabled',
  ]);
  assert.equal(args.includes('--enable-features=KeepEnabled'), true);
  assert.equal(args.filter((arg) => arg.startsWith('--disable-features=')).length, 1);
  const disabled = args.find((arg) => arg.startsWith('--disable-features='));
  assert.match(disabled, /OptimizationGuideOnDeviceModel/);
  assert.match(disabled, /OnDeviceModelBackgroundDownload/);
  assert.match(disabled, /AlreadyDisabled/);
});

test('启动后台清理仅删除未运行 Profile 的本地模型目录', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-models-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const removable = path.join(root, 'profile-a', 'chromium-data', 'OptGuideOnDeviceModel');
  const lockedRoot = path.join(root, 'profile-b');
  const locked = path.join(lockedRoot, 'chromium-data', 'OptGuideOnDeviceModel');
  fs.mkdirSync(removable, { recursive: true });
  fs.mkdirSync(locked, { recursive: true });
  fs.writeFileSync(path.join(removable, 'weights.bin'), 'model');
  fs.writeFileSync(path.join(locked, 'weights.bin'), 'model');
  fs.writeFileSync(path.join(lockedRoot, '.runtime.lock'), JSON.stringify({ pid: process.pid }));

  const results = await cleanupLocalModels(root, { info() {}, warn() {} });

  assert.equal(results.find((item) => item.profile === 'profile-a').status, 'removed');
  assert.equal(results.find((item) => item.profile === 'profile-b').status, 'skipped');
  assert.equal(fs.existsSync(removable), false);
  assert.equal(fs.existsSync(locked), true);
});
