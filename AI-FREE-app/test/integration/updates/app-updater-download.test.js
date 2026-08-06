'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { appContext } = require('../../../src/app/main/runtime/app-context');

const originalCwd = process.cwd();
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-app-updater-'));
process.chdir(fixtureRoot);
const { createAppUpdater } = require('../../../src/app/main/services/app-updater');

test.after(() => {
  appContext.clearPendingUpdateInstall();
  process.chdir(originalCwd);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

test('direct update download reports progress and stages installer for application exit', async () => {
  const payload = Buffer.from('fixture-installer');
  const server = http.createServer((request, response) => {
    if (request.url === '/installer.exe') {
      response.writeHead(200, { 'Content-Length': payload.length });
      response.end(payload);
      return;
    }
    response.writeHead(503);
    response.end('unavailable');
  });
  await listen(server);
  const events = [];
  const progress = [];
  const titles = [];
  const updater = createAppUpdater({
    app: { getVersion: () => '2.6.7' },
    appName: 'AI-FREE Fixture',
    getMainWindow: () => ({
      isDestroyed: () => false,
      setProgressBar: (value) => progress.push(value),
      setTitle: (value) => titles.push(value),
    }),
    logger: silentLogger(),
    sendToSide: (channel, event) => events.push([channel, event]),
  });
  try {
    const { port } = server.address();
    const result = await updater.startAppUpdate({
      app_version: '2.7.0',
      package_url: `http://127.0.0.1:${port}/installer.exe`,
      file_name: 'installer.exe',
      entry_file: 'installer.exe',
    });
    assert.equal(result.ok, true);
    assert.equal(result.version, '2.7.0');
    assert.equal(path.basename(result.launchTarget), 'installer.exe');
    assert.deepEqual(fs.readFileSync(result.launchTarget), payload);
    assert.equal(events[0][0], 'app-update-activated');
    assert.equal(events.some(([channel, event]) => channel === 'app-update-progress' && event.phase === 'downloading'), true);
    assert.equal(events.at(-1)[0], 'app-update-complete');
    assert.equal(progress.includes(0), true);
    assert.equal(progress.includes(-1), true);
    assert.equal(titles.at(-1), 'AI-FREE Fixture');
    assert.deepEqual(appContext.getPendingUpdateInstall(), { version: '2.7.0', target: result.launchTarget });
  } finally {
    await close(server);
  }
});

test('incomplete and failed updates return errors and release the in-progress lock', async () => {
  const incompleteEvents = [];
  const updater = createAppUpdater({
    app: { getVersion: () => '2.6.7' },
    logger: silentLogger(),
    sendToSide: (channel, event) => incompleteEvents.push([channel, event]),
  });
  assert.match((await updater.startAppUpdate({ app_version: '2.7.0' })).message, /信息不完整/);

  const server = http.createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(503);
      response.end('failure');
    }, 20);
  });
  await listen(server);
  try {
    const { port } = server.address();
    const first = updater.startAppUpdate({
      app_version: '2.7.1',
      package_url: `http://127.0.0.1:${port}/failure.exe`,
      file_name: 'failure.exe',
      entry_file: 'failure.exe',
    });
    const concurrent = await updater.startAppUpdate({
      app_version: '2.7.2',
      package_url: `http://127.0.0.1:${port}/later.exe`,
    });
    assert.equal(concurrent.ok, false);
    assert.match(concurrent.message, /正在进行中/);
    const failed = await first;
    assert.equal(failed.ok, false);
    assert.match(failed.message, /HTTP 状态码 503/);
    assert.equal(incompleteEvents.some(([channel]) => channel === 'app-update-error'), true);
  } finally {
    await close(server);
  }
});

test('server command distinguishes non-update, receipt, incomplete and current versions', async () => {
  const events = [];
  const updater = createAppUpdater({
    app: { getVersion: () => '2.6.7' },
    logger: silentLogger(),
    sendToSide: (channel, event) => events.push([channel, event]),
  });
  assert.equal(await updater.handleServerUpdateCommand({ type: 'announcement', message: 'hello' }), false);
  assert.equal(await updater.handleServerUpdateCommand({ message_type: 'update', status: 'downloaded' }), false);
  assert.equal(await updater.handleServerUpdateCommand({ type: 'update', app_version: '2.7.0' }), true);
  assert.equal(await updater.handleServerUpdateCommand({ type: 'update', app_version: '2.6.7', package_url: 'https://example.test/a.zip' }), false);
  assert.equal(events.at(-1)[0], 'app-update-skip');
  assert.equal(await updater.handleServerUpdateCommand({ type: 'update', app_version: '2.7.0', package_url: 'https://example.test/a.zip' }), false);
  assert.equal(events.at(-1)[0], 'app-update-notice');
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function silentLogger() {
  return { error() {}, warn() {} };
}
