'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createRuntimeHelpers } = require('../../src/app/main/services/runtime-helpers');

function createHelpers({ existingDirectories = [], candidates = [] } = {}) {
  const existing = new Set(existingDirectories.map((dir) => path.normalize(dir)));
  return createRuntimeHelpers({
    app: null,
    fs: {
      existsSync: (dir) => existing.has(path.normalize(dir)),
      statSync: (dir) => ({ isDirectory: () => existing.has(path.normalize(dir)) }),
    },
    path,
    logger: { log() {}, warn() {}, error() {} },
    getHardwareFingerprint: async () => 'fingerprint',
    getTranslateExtDirCandidates: () => candidates,
  });
}

test('missing optional translate extension resolves to an empty path', () => {
  const helpers = createHelpers({ candidates: ['C:\\missing\\transform'] });
  assert.equal(helpers.getTranslateExtDir(), '');
});

test('missing optional translate extension is not loaded into a session', async () => {
  let loadCount = 0;
  const helpers = createHelpers({ candidates: ['C:\\missing\\transform'] });
  const result = await helpers.loadTranslateExtension({
    extensions: { loadExtension: async () => { loadCount += 1; } },
  });

  assert.equal(result, null);
  assert.equal(loadCount, 0);
});

test('installed translate extension still resolves and loads normally', async () => {
  const dir = 'C:\\extensions\\transform';
  let loadedPath = '';
  const helpers = createHelpers({ existingDirectories: [dir], candidates: [dir] });
  await helpers.loadTranslateExtension({
    extensions: {
      loadExtension: async (extDir) => {
        loadedPath = extDir;
        return { id: 'translate-id', name: 'translate' };
      },
    },
  });

  assert.equal(helpers.getTranslateExtDir(), path.normalize(dir));
  assert.equal(loadedPath, path.normalize(dir));
});
