'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createAiSandboxFileTools,
  resolveInside,
} = require('../../../src/app/main/services/ai-sandbox-file-tools');
const { ProfileRuntimeStore } = require('../../../src/app/main/browser-runtime/profile-runtime-store');

test('sandbox_files lists upload assets with absolute paths and download workspace', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-workspace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'images'));
  fs.writeFileSync(path.join(root, 'images', 'asset.png'), 'png');
  const tools = createAiSandboxFileTools({ sandboxDir: root });

  const info = await tools.execute('sandbox_files', { action: 'info' });
  const listed = await tools.execute('sandbox_files', { action: 'list' });
  assert.equal(info.download_path, root);
  assert.equal(
    listed.items.find((item) => item.name === 'asset.png').absolute_path,
    path.join(root, 'images', 'asset.png'),
  );
});

test('sandbox_files rejects traversal outside the workspace', () => {
  const root = path.join(os.tmpdir(), 'ai-free-workspace-boundary');
  assert.throws(() => resolveInside(root, '..'), /超出 AI 工作区/);
});

test('all Chromium profiles use the shared workspace without nesting it in profile data', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-profile-workspace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'AI-Workspace');
  const store = new ProfileRuntimeStore({
    rootDir: path.join(root, 'profiles'),
    downloadsDir: workspace,
  });
  assert.equal(store.getProfilePaths('one').downloads, workspace);
  assert.equal(store.getProfilePaths('two').downloads, workspace);
});
