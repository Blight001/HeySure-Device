'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTabManager } = require('../../../src/app/main/services/tab-manager');

let chromiumRestarts = 0;
let sidebarEvent = null;
const chromiumProfile = { extensionPaths: ['old-extension'] };
const tabs = new Map([
  ['chromium-tab', { id: 'chromium-tab', runtimeType: 'chromium', runtimeStatus: 'ready', browserSettings: {} }],
]);

const browserRuntimeManager = {
  chromium: { instances: new Map([['chromium-tab', { profile: chromiumProfile }]]) },
  restart: async () => { chromiumRestarts += 1; return { status: 'ready' }; },
};
const extensionManager = { getEnabledExtensionPaths: () => ['enabled-extension'] };
const manager = createTabManager({
  browserRuntimeManager,
  extensionManager,
  fs,
  path,
  getTabs: () => tabs,
  updateTabs: () => {},
  sendToSide: (channel, payload) => { sidebarEvent = { channel, payload }; },
});

(async () => {
  const result = await manager.refreshBrowsersAfterExtensionChange({ plugin: { id: 'test-plugin' }, enabled: true });
  assert.equal(result.ok, true);
  assert.equal(result.chromiumRestarted, 1);
  assert.equal(result.total, 1);
  assert.equal(chromiumRestarts, 1);
  assert.deepEqual(chromiumProfile.extensionPaths, ['enabled-extension']);
  assert.equal(sidebarEvent.channel, 'extension-browsers-refreshed');
  console.log('extension browser refresh checks passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
