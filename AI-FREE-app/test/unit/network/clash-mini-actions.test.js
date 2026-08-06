'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const corePath = require.resolve('../../../src/app/main/ipc/register/clash-mini-core');
const actionsPath = require.resolve('../../../src/app/main/ipc/register/clash-mini-actions');
const proxyOptionsPath = require.resolve('../../../src/app/main/ipc/register/clash-mini-proxy-options');
const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-clash-actions-'));
const controlCalls = [];
const collectedNames = [];

require.cache[corePath] = {
  exports: {
    collectClashMiniProxyDelays: async (_root, names) => {
      collectedNames.push([...names]);
      return names.map((name) => ({ name, delay: 72, delayText: '72ms', ok: true }));
    },
    emitClashMiniLog: () => {},
    fetchClashMiniProxyNames: async () => ({ names: ['A', 'B'], current: 'A' }),
    getClashMiniManualGroupName: () => 'Manual',
    getClashMiniRuntimeRoot: () => runtimeRoot,
    getClashMiniStatus: () => ({ running: true, coreDir: runtimeRoot }),
    normalizeProbeTimeout: (value, fallback) => Number(value) || fallback,
    normalizeProbeUrl: (value, fallback) => value || fallback,
    probeClashMiniGroupDelay: async () => ({ A: 25, B: 30 }),
    probeClashMiniProxyDelay: async () => ({ delay: 64 }),
    readClashProbeSettings: () => ({}),
    startClashMiniProcess: async () => ({ ok: true }),
    waitForClashMiniControlApi: async () => true,
    invokeClashMiniControl: async (_root, method, pathname, options = {}) => {
      controlCalls.push({ method, pathname, options });
      if (method === 'get' && pathname === '/proxies') {
        return { proxies: { A: { history: [{ delay: 41 }] }, B: { history: [] } } };
      }
      return { proxies: {} };
    },
  },
};
delete require.cache[actionsPath];
delete require.cache[proxyOptionsPath];
const actions = require(actionsPath);

test.after(() => {
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  delete require.cache[actionsPath];
  delete require.cache[proxyOptionsPath];
  delete require.cache[corePath];
});

test('节点获取复用已有延时，只主动补测没有记录的节点', async () => {
  const result = await actions.getClashMiniProxyGroupOptions(null);

  assert.equal(result.ok, true);
  assert.deepEqual(collectedNames, [['B']]);
  assert.deepEqual(result.proxies.map(({ name, delay }) => ({ name, delay })), [
    { name: 'A', delay: 41 },
    { name: 'B', delay: 72 },
  ]);
});

test('单节点重新测速不切换当前节点', async () => {
  controlCalls.length = 0;
  const progress = [];
  const result = await actions.testClashMiniLowestLatency({
    sendToSide: (_channel, payload) => progress.push(payload),
  }, { names: ['B'], selectBest: false, reportProgress: true });

  assert.equal(result.ok, true);
  assert.equal(result.entries[0].name, 'B');
  assert.equal(controlCalls.some((call) => call.method === 'put'), false);
  assert.equal(progress.at(-1).bestName, '');
});
