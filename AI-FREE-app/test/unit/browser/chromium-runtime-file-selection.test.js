'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { BrowserRuntimeManager } = require('../../../src/app/main/browser-runtime');
const { ChromiumRuntime } = require('../../../src/app/main/browser-runtime/chromium-runtime');
const {
  assertPathsInSandbox,
  prepareRuntimeFileSelection,
} = require('../../../src/app/main/browser-runtime/runtime-file-selection');

test('runtime file selection rejects paths outside the configured AI workspace', () => {
  const root = path.join(os.tmpdir(), 'ai-free-sandbox');
  assert.doesNotThrow(() => assertPathsInSandbox([path.join(root, 'asset.png')], root));
  assert.throws(
    () => assertPathsInSandbox([path.join(os.tmpdir(), 'secret.png')], root),
    (error) => error.code === 'FILE_SELECTION_OUTSIDE_SANDBOX',
  );
});

function createRuntime(sent) {
  const store = { getState: () => ({ status: 'ready' }) };
  const runtime = new ChromiumRuntime({ store, logger: { warn() {} } });
  runtime.instances.set('profile-a', {
    child: { pid: 4321, exitCode: null },
    commandClient: {
      send: async (type, payload) => {
        sent.push({ type, payload });
        return { ok: true, result: { queued: true, count: payload.paths.length } };
      },
    },
  });
  return runtime;
}

test('selectFilesByProcessId validates a local file and queues an exact-origin request', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-file-selection-'));
  const filePath = path.join(root, 'clip.mp4');
  const sent = [];
  try {
    fs.writeFileSync(filePath, 'video-fixture');
    const manager = new BrowserRuntimeManager({ userDataDir: root, chromiumRuntime: createRuntime(sent) });
    const response = await manager.selectFilesByProcessId(4321, {
      pageUrl: 'https://video.example.test/create?tab=upload',
      path: filePath,
      ttlMs: 5000,
    });
    assert.equal(response.result.queued, true);
    assert.deepEqual(sent, [{
      type: 'select-files',
      payload: {
        origin: 'https://video.example.test',
        paths: [filePath],
        mode: 'open',
        ttlMs: 5000,
      },
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('file selection rejects missing paths, wrong types, and non-http origins', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-file-selection-invalid-'));
  try {
    await assert.rejects(
      prepareRuntimeFileSelection({ origin: 'https://example.test', path: path.join(root, 'missing.mp4') }),
      (error) => error.code === 'FILE_SELECTION_PATH_NOT_FOUND',
    );
    await assert.rejects(
      prepareRuntimeFileSelection({ origin: 'https://example.test', path: root }),
      (error) => error.code === 'FILE_SELECTION_PATH_TYPE_INVALID',
    );
    await assert.rejects(
      prepareRuntimeFileSelection({ origin: 'file:///local/page.html', mode: 'upload-folder', path: root }),
      (error) => error.code === 'FILE_SELECTION_ORIGIN_INVALID',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
