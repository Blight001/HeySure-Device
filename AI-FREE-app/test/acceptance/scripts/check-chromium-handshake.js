'use strict';

const assert = require('assert');
const net = require('net');
const { ChromiumCommandClient, encodeFrame, PROTOCOL_VERSION } = require('../../../src/app/main/browser-runtime/chromium-command-client');

function readFrame(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error('handshake response timeout')), 5000);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (buffer.length < length + 4) return;
      clearTimeout(timer);
      socket.off('data', onData);
      resolve(JSON.parse(buffer.subarray(4, length + 4).toString('utf8')));
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
}

function nextFrame(socket) {
  return readFrame(socket);
}

(async () => {
  const profileId = 'phase2_handshake_test';
  const launchToken = 'one-time-phase2-token';
  const server = new ChromiumCommandClient({ profileId, launchToken, expectedPid: process.pid });
  await server.listen();
  const chromium = net.createConnection(server.pipeName);
  await new Promise((resolve, reject) => {
    chromium.once('connect', resolve);
    chromium.once('error', reject);
  });
  chromium.write(encodeFrame({
    type: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    profileId,
    pid: process.pid,
    browserHwnd: '123456',
    launchToken,
  }));
  const accepted = await readFrame(chromium);
  assert.equal(accepted.type, 'hello-accepted');
  assert(accepted.sessionId);
  assert.equal(accepted.heartbeatIntervalMs, 3000);
  const heartbeatReceived = new Promise((resolve) => server.once('heartbeat', resolve));
  chromium.write(encodeFrame({
    type: 'heartbeat',
    protocolVersion: PROTOCOL_VERSION,
    profileId,
    sessionId: accepted.sessionId,
  }));
  await heartbeatReceived;
  assert.equal(server.handshakeComplete, true);
  assert.equal(/** @type {any} */ (server.lastHello).browserHwnd, '123456');

  const navigatePromise = server.send('navigate', { url: 'https://example.com/' });
  const navigateCommand = await nextFrame(chromium);
  assert.equal(navigateCommand.type, 'navigate');
  assert.equal(navigateCommand.protocolVersion, PROTOCOL_VERSION);
  assert.equal(navigateCommand.profileId, profileId);
  assert.equal(navigateCommand.sessionId, accepted.sessionId);
  assert(navigateCommand.requestId);
  chromium.write(encodeFrame({
    type: 'response',
    protocolVersion: PROTOCOL_VERSION,
    profileId,
    sessionId: accepted.sessionId,
    requestId: navigateCommand.requestId,
    command: 'navigate',
    ok: true,
    result: { url: 'https://example.com/', title: 'Example Domain' },
  }));
  const navigateResponse = await navigatePromise;
  assert.equal(navigateResponse.result.title, 'Example Domain');

  const inputPromise = server.send('dispatch-input', {
    inputType: 'mouse', action: 'click', x: 40, y: 50,
    viewportWidth: 800, viewportHeight: 600,
  });
  const inputCommand = await nextFrame(chromium);
  assert.equal(inputCommand.type, 'dispatch-input');
  assert.equal(inputCommand.action, 'click');
  assert.equal(inputCommand.x, 40);
  assert.equal(inputCommand.viewportWidth, 800);
  chromium.write(encodeFrame({
    type: 'response',
    protocolVersion: PROTOCOL_VERSION,
    profileId,
    sessionId: accepted.sessionId,
    requestId: inputCommand.requestId,
    command: 'dispatch-input',
    ok: true,
    result: { dispatched: true },
  }));
  const inputResponse = await inputPromise;
  assert.equal(inputResponse.result.dispatched, true);

  const reloadPromise = server.send('reload');
  const reloadCommand = await nextFrame(chromium);
  chromium.write(encodeFrame({
    type: 'response',
    protocolVersion: PROTOCOL_VERSION,
    profileId,
    sessionId: accepted.sessionId,
    requestId: reloadCommand.requestId,
    command: 'reload',
    ok: false,
    error: { code: 'RELOAD_FAILED', message: 'reload rejected for test' },
  }));
  await assert.rejects(reloadPromise, (error) => /** @type {any} */ (error).code === 'RELOAD_FAILED');
  await assert.rejects(server.send('not-allowed'), (error) => /** @type {any} */ (error).code === 'COMMAND_NOT_ALLOWED');
  chromium.destroy();
  await server.close();
  console.log('chromium named-pipe handshake checks passed');
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
