'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { resolveAiSandboxDir } = require('../../../src/app/main/config/paths');

test('AI workspace resolves next to the packaged executable', () => {
  const exe = path.join('C:\\Program Files', 'AI-FREE', 'AI-FREE.exe');
  const app = { isPackaged: true, getPath: (name) => name === 'exe' ? exe : '' };
  assert.equal(resolveAiSandboxDir(app), path.join(path.dirname(exe), 'AI-Workspace'));
});

test('development workspace resolves above the generated app', () => {
  const project = path.join('D:\\work', 'ai-free');
  const app = { isPackaged: false, getAppPath: () => path.join(project, '.generated', 'app') };
  const fakeFs = { existsSync: (candidate) => candidate === path.join(project, 'package.json') };
  assert.equal(resolveAiSandboxDir(app, { fs: fakeFs }), path.join(project, 'AI-Workspace'));
});
