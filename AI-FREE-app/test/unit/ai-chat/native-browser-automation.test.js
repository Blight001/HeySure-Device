'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createNativeBrowserAutomation } = require('../../../src/app/main/services/native-browser-automation');

function fixture() {
  const calls = [];
  const runtime = {
    listStates: () => [{
      profileId: 'profile-a', pid: 42, status: 'ready', bridgeConnected: true,
      startedAt: 100, lastHeartbeatAt: 200,
    }],
    dispatchAutomationByProcessId: async (...args) => {
      calls.push(['automation', ...args]);
      return { result: { success: true, command: args[1] } };
    },
    focus: async (...args) => calls.push(['focus', ...args]),
    navigate: async (...args) => calls.push(['navigate', ...args]),
    openTabs: async (...args) => calls.push(['openTabs', ...args]),
    reload: async (...args) => calls.push(['reload', ...args]),
    selectFilesByProcessId: async (...args) => calls.push(['files', ...args]),
  };
  const service = createNativeBrowserAutomation({
    browserRuntimeManager: runtime,
    getTabs: () => new Map([['profile-a', {
      id: 'profile-a', fixedTitle: '工作浏览器', runtimeUrl: 'https://example.com/',
    }]]),
    browserDownloadService: { execute: async (args) => ({ success: true, action: args.action }) },
  });
  return { calls, service };
}

test('native automation publishes ready managed Chromium as the browser connection', () => {
  const { service } = fixture();
  const connections = service.listConnections();
  assert.equal(connections.length, 1);
  assert.equal(connections[0].id, 'native:profile-a');
  assert.equal(connections[0].name, '工作浏览器');
  assert.equal(connections[0].platform, 'ai-free-chromium-native');
  assert.equal(service.getConnection(connections[0].id).tools.length, 7);
});

test('observe and action dispatch directly to the Chromium runtime bridge', async () => {
  const { calls, service } = fixture();
  const observed = await service.dispatch('native:profile-a', 'browser_observe', { limit: 5 });
  const clicked = await service.dispatch('native:profile-a', 'browser_action', { action: 'click', selector: '#go' });
  assert.equal(observed.command, 'observe-page');
  assert.equal(clicked.command, 'perform-action');
  assert.deepEqual(calls, [
    ['automation', 42, 'observe-page', { limit: 5 }],
    ['automation', 42, 'perform-action', { action: 'click', selector: '#go' }],
  ]);
});

test('native tab and session operations do not enqueue extension tasks', async () => {
  const { calls, service } = fixture();
  await service.dispatch('native:profile-a', 'browser_tab', { action: 'replace', url: 'example.org' });
  await service.dispatch('native:profile-a', 'browser_download', { action: 'save_session' });
  assert.deepEqual(calls[0], ['navigate', 'profile-a', 'chromium', 'https://example.org/']);
  assert.deepEqual(calls[1], ['automation', 42, 'get-session-data', {}]);
});
