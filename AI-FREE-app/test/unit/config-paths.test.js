'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { resolveChromiumResourcesPath } = require('../../src/app/main/config/paths');

test('staged development app resolves Chromium resources from the project root', () => {
  const projectRoot = path.resolve(__dirname, '../..');
  const stagedAppRoot = path.join(projectRoot, '.generated', 'app');
  const resourcesPath = resolveChromiumResourcesPath({
    isPackaged: false,
    getAppPath: () => stagedAppRoot,
  }, {
    workingDirectory: projectRoot,
    moduleDirectory: path.join(stagedAppRoot, 'src', 'app', 'main', 'config'),
  });

  assert.equal(resourcesPath, path.join(projectRoot, 'resources'));
});
