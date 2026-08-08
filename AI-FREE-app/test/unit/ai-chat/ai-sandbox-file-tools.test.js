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

test('run_command executes in an AI-Workspace subdirectory and returns bounded output', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-workspace-command-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'jobs'));
  const tools = createAiSandboxFileTools({ sandboxDir: root });
  const command = process.platform === 'win32'
    ? 'echo hello>result.txt && type result.txt'
    : 'printf hello > result.txt && cat result.txt';

  assert.equal(tools.has('run_command'), true);
  assert.equal(tools.tools[0].name, 'run_command');
  const result = await tools.execute('run_command', { command, directory: 'jobs' });
  assert.equal(result.success, true);
  assert.match(result.stdout, /hello/);
  assert.equal(result.directory, 'jobs');
  assert.equal(fs.readFileSync(path.join(root, 'jobs', 'result.txt'), 'utf8').trim(), 'hello');
});

test('run_command rejects working directories outside AI-Workspace', () => {
  assert.throws(() => resolveInside('C:/workspace', '../outside'), /超出 AI 工作区/);
});

test('all Chromium profiles use the shared workspace without nesting it in profile data', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-profile-workspace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'AI-Workspace');
  const store = new ProfileRuntimeStore({
    rootDir: path.join(root, 'profiles'),
    downloadsDir: workspace,
  });
  assert.equal(store.getProfilePaths('one').downloads, workspace);
  assert.equal(store.getProfilePaths('two').downloads, workspace);
});
