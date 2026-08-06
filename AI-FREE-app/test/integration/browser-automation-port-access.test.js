'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');

const {
  APP_BROWSER_PID_HEADER,
  CONNECTION_TTL_MS,
  createBrowserAutomationBridge,
} = require('../../src/app/main/services/browser-automation-bridge');

async function reserveFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('automation bridge heartbeat grace covers the MV3 offscreen wake interval', () => {
  const offscreenWakeIntervalMs = 20_000;
  assert.ok(
    CONNECTION_TTL_MS >= offscreenWakeIntervalMs * 2,
    `heartbeat grace ${CONNECTION_TTL_MS}ms is shorter than two offscreen wake intervals`,
  );
});

test('automation bridge accepts browser extensions through the loopback port', async (t) => {
  const port = await reserveFreePort();
  const bridge = createBrowserAutomationBridge({
    port,
    isAllowedBrowserProcess: () => false,
    logger: { log() {}, warn() {} },
  });
  await bridge.start();
  t.after(() => bridge.stop());

  const url = `http://127.0.0.1:${port}`;
  const headers = {
    Origin: 'chrome-extension://external-browser-extension',
    [APP_BROWSER_PID_HEADER]: '98765',
  };
  const health = await fetch(`${url}/health`, { headers });
  assert.equal(health.status, 200);

  const registration = await fetch(`${url}/v1/register`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instanceId: 'external-browser',
      sessionId: 'one',
      browserProcessId: 98765,
      toolDefs: [{ name: 'browser_tab' }],
    }),
  });
  assert.equal(registration.status, 200);
  const connection = await registration.json();
  assert.ok(connection.connectionId);
  assert.ok(connection.token);

  const heartbeat = await fetch(
    `${url}/v1/heartbeat?connection_id=${encodeURIComponent(connection.connectionId)}`,
    { method: 'POST', headers: { ...headers, 'X-Bridge-Token': connection.token } },
  );
  assert.equal(heartbeat.status, 200);

  const wrongConnection = await fetch(
    `${url}/v1/heartbeat?connection_id=${encodeURIComponent(connection.connectionId)}`,
    { method: 'POST', headers: { ...headers, 'X-Bridge-Token': 'wrong-token' } },
  );
  assert.equal(wrongConnection.status, 401);
});
