'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createBrowserAutomationBridge } = require('../../src/app/main/services/browser-automation-bridge');

async function reservePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('automation bridge exposes authenticated external MCP before extension authentication', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-bridge-external-mcp-'));
  const descriptorPath = path.join(root, 'ai-free-mcp-bridge.json');
  const port = await reservePort();
  const bridge = createBrowserAutomationBridge({
    cardCacheDir: path.join(root, 'cards'),
    externalMcpDescriptorPath: descriptorPath,
    getExternalMcpAccess: () => true,
    logger: { log() {}, warn() {} },
    port,
  });
  const executed = [];
  bridge.configureExternalMcp({
    getConnections: () => [],
    getWindowTools: () => ({
      tools: [{ name: 'software_window', description: '管理窗口', input_schema: { type: 'object', properties: { action: { type: 'string' } } } }],
      has: (name) => name === 'software_window',
      execute: async (name, args) => {
        executed.push({ name, args });
        return { success: true, total: 0, items: [] };
      },
    }),
  });
  try {
    await bridge.start();
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
    const headers = { 'x-ai-free-mcp-token': descriptor.token };
    const listedResponse = await fetch(`${descriptor.endpoint}/mcp/v1/tools`, { headers });
    assert.equal(listedResponse.status, 200);
    const listed = await listedResponse.json();
    assert.deepEqual(listed.tools.map((tool) => tool.name), ['software_window']);

    const calledResponse = await fetch(`${descriptor.endpoint}/mcp/v1/call`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'software_window', arguments: { action: 'list' } }),
    });
    assert.equal(calledResponse.status, 200);
    const called = await calledResponse.json();
    assert.equal(called.result.total, 0);
    assert.deepEqual(executed, [{ name: 'software_window', args: { action: 'list' } }]);
  } finally {
    await bridge.stop();
    assert.equal(fs.existsSync(descriptorPath), false);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('external MCP reports VIP requirement while calls follow live membership access', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-bridge-external-mcp-vip-'));
  const descriptorPath = path.join(root, 'ai-free-mcp-bridge.json');
  fs.writeFileSync(descriptorPath, JSON.stringify({ pid: 1, token: 'stale' }), 'utf8');
  const port = await reservePort();
  let isVip = false;
  const bridge = createBrowserAutomationBridge({
    cardCacheDir: path.join(root, 'cards'),
    externalMcpDescriptorPath: descriptorPath,
    getExternalMcpAccess: () => ({ isVip }),
    logger: { log() {}, warn() {} },
    port,
  });
  bridge.configureExternalMcp({
    getConnections: () => [],
    getWindowTools: () => ({
      tools: [{ name: 'software_window', description: '管理窗口', input_schema: { type: 'object', properties: { action: { type: 'string' } } } }],
      has: (name) => name === 'software_window',
      execute: async () => ({ success: true, total: 0, items: [] }),
    }),
  });
  try {
    await bridge.start();
    assert.equal(fs.existsSync(descriptorPath), true);
    const freeDescriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
    const freeHeaders = { 'x-ai-free-mcp-token': freeDescriptor.token };
    const freeStatus = await fetch(`${freeDescriptor.endpoint}/mcp/v1/status`, { headers: freeHeaders });
    assert.equal(freeStatus.status, 200);
    assert.equal((await freeStatus.json()).membershipRequired, true);
    const freeTools = await fetch(`${freeDescriptor.endpoint}/mcp/v1/tools`, { headers: freeHeaders });
    assert.equal(freeTools.status, 403);
    assert.equal((await freeTools.json()).error, 'AI_FREE_MCP_VIP_REQUIRED');

    isVip = true;
    assert.equal(bridge.refreshExternalMcpAccess(), true);
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
    assert.notEqual(descriptor.token, freeDescriptor.token);
    const headers = { 'x-ai-free-mcp-token': descriptor.token };
    const memberStatus = await fetch(`${descriptor.endpoint}/mcp/v1/status`, { headers });
    assert.equal(memberStatus.status, 200);
    assert.equal((await memberStatus.json()).membershipRequired, false);

    isVip = false;
    assert.equal(bridge.refreshExternalMcpAccess(), true);
    assert.equal(fs.existsSync(descriptorPath), true);
    const denied = await fetch(`${descriptor.endpoint}/mcp/v1/status`, { headers });
    assert.equal(denied.status, 401);

    const revoked = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
    const revokedHeaders = { 'x-ai-free-mcp-token': revoked.token };
    const revokedStatus = await fetch(`${revoked.endpoint}/mcp/v1/status`, { headers: revokedHeaders });
    assert.equal(revokedStatus.status, 200);
    assert.equal((await revokedStatus.json()).membershipRequired, true);
    const revokedCall = await fetch(`${revoked.endpoint}/mcp/v1/call`, {
      method: 'POST',
      headers: { ...revokedHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'software_window', arguments: { action: 'list' } }),
    });
    assert.equal(revokedCall.status, 403);
    assert.equal((await revokedCall.json()).error, 'AI_FREE_MCP_VIP_REQUIRED');
  } finally {
    await bridge.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
