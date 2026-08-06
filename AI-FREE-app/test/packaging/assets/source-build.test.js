'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildRoot, buildSource, moduleKindFor } = require('../../../scripts/build-source');

test('统一源码构建按 Electron 进程边界选择模块格式', () => {
  assert.equal(moduleKindFor('app/main/main.ts'), 'commonjs');
  assert.equal(moduleKindFor('app/preload/index.ts'), 'commonjs');
  assert.equal(moduleKindFor('app/sidebar/client/bootstrap.ts'), 'esmodule');
  assert.equal(moduleKindFor('app/renderer/index.ts'), 'esmodule');
});

test('统一源码构建生成可加载主进程模块和可追踪 manifest', () => {
  const manifest = buildSource();
  const manifestPath = path.join(buildRoot, 'build-manifest.json');
  assert.equal(fs.existsSync(manifestPath), true);
  assert.equal(manifest.mainFormat, 'commonjs');
  assert.equal(manifest.rendererFormat, 'esmodule');
  assert.match(manifest.sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(manifest.extensionServiceWorkers.some((entry) => entry.extension === 'browser_automation'), false);
  const registryPath = path.join(buildRoot, 'src/app/main/features/ai-chat/chat-run-registry.js');
  delete require.cache[require.resolve(registryPath)];
  assert.equal(typeof require(registryPath).createChatRunRegistry, 'function');
});

test('开发、测试和 Windows 打包脚本共享 prepare:source 入口', () => {
  const projectDir = path.resolve(__dirname, '../../..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
  for (const name of ['start', 'start:electron', 'start:dev', 'start:chromium', 'build', 'build:portable', 'pretest']) {
    assert.match(packageJson.scripts[name], /prepare:source/);
  }
  const sourceMapping = packageJson.build.files.find((entry) => entry && typeof entry === 'object');
  assert.equal(sourceMapping.from, '.generated/app/src');
  assert.equal(sourceMapping.to, 'src');
});
