'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..', '..', '..');

function loadPreloadApi() {
  const exposed = {};
  const calls = [];
  const ipcRenderer = new EventEmitter();
  ipcRenderer.invoke = async (channel, data) => { calls.push(['invoke', channel, data]); return { channel, data }; };
  ipcRenderer.send = (channel, data) => { calls.push(['send', channel, data]); };
  const context = vm.createContext({
    console,
    process: { env: {} },
    window: { addEventListener() {}, postMessage() {} },
    require(request) {
      if (request === 'electron') {
        return {
          contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
          ipcRenderer,
        };
      }
      throw new Error(`sandboxed preload cannot require ${request}`);
    },
  });
  const preloadPath = path.join(projectRoot, 'src/app/main/preload.js');
  vm.runInContext(fs.readFileSync(preloadPath, 'utf8'), context, { filename: preloadPath });
  return { calls, exposed, ipcRenderer };
}

test('window.aiFree AI methods bind fixed channels and subscriptions return disposers', async () => {
  const { calls, exposed, ipcRenderer } = loadPreloadApi();
  assert.equal(Object.isFrozen(exposed.aiFree), true);
  assert.equal(Object.isFrozen(exposed.aiFree.ai), true);

  await exposed.aiFree.ai.chat({ requestId: 'request-1' });
  await exposed.aiFree.ai.getPromptDiagnostics({ modelId: 'model-1' });
  await exposed.aiFree.ai.manageAutomationCard({ action: 'list' });
  await exposed.aiFree.ai.saveAutomationSession({ connectionId: 'native:p1' });
  exposed.aiFree.ai.emitBrowserSelectionChanged({ ids: ['browser-1'] });
  assert.deepEqual(calls, [
    ['invoke', 'ai-control-chat', { requestId: 'request-1' }],
    ['invoke', 'ai-control-get-prompt-diagnostics', { modelId: 'model-1' }],
    ['invoke', 'ai-control-manage-automation-card', { action: 'list' }],
    ['invoke', 'ai-control-save-automation-session', { connectionId: 'native:p1' }],
    ['send', 'ai-control-browser-selection-changed', { ids: ['browser-1'] }],
  ]);

  const events = [];
  const unsubscribe = exposed.aiFree.ai.onChatEvent((payload) => events.push(payload));
  ipcRenderer.emit('ai-control-chat-event', { sender: 'private' }, { type: 'done' });
  unsubscribe();
  ipcRenderer.emit('ai-control-chat-event', {}, { type: 'late' });
  assert.deepEqual(events, [{ type: 'done' }]);
});

test('AI renderer modules cannot regress to arbitrary-channel electronAPI', () => {
  // Static inspection is intentional here: this is an architectural capability
  // boundary, not a functional UI assertion.
  const root = path.join(
    projectRoot,
    'src/app/sidebar/client/app/side/controllers/pages/ai-control',
  );
  const files = fs.readdirSync(root)
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(root, name));
  const violations = files.filter((file) => fs.readFileSync(file, 'utf8').includes('electronAPI'));
  assert.deepEqual(violations, []);
});

test('account domain methods bind fixed channels and migrated account modules stay narrow', async () => {
  const { calls, exposed } = loadPreloadApi();
  await exposed.aiFree.account.authenticate({ mode: 'password' });
  await exposed.aiFree.license.redeemVipGiftCode({ code: 'fixture-code' });
  assert.deepEqual(calls, [
    ['invoke', 'account-authenticate', { mode: 'password' }],
    ['invoke', 'redeem-vip-gift-code', { code: 'fixture-code' }],
  ]);
  assert.equal('openCenterPopup' in exposed.aiFree.account, false);
  assert.equal('resizeCenterPopup' in exposed.aiFree.account, false);

  // Capability-boundary inspection: these modules must not regain an API that
  // accepts caller-provided channel names.
  const root = path.join(
    projectRoot,
    'src/app/sidebar/client/app/side/controllers/pages/side-panel/modules',
  );
  const violations = fs.readdirSync(root)
    .filter((name) => /^(?:account-auth|license).*\.js$/.test(name))
    .map((name) => path.join(root, name))
    .filter((file) => fs.readFileSync(file, 'utf8').includes('electronAPI'));
  assert.deepEqual(violations, []);
});

test('license methods expose named operations without caller-provided channels', async () => {
  const { calls, exposed } = loadPreloadApi();
  await exposed.aiFree.license.getVipPlans();
  assert.deepEqual(calls, [['invoke', 'get-vip-plans', undefined]]);
  assert.equal('invoke' in exposed.aiFree.license, false);
  assert.equal('send' in exposed.aiFree.license, false);
  assert.equal('on' in exposed.aiFree.license, false);
});

test('browser, network, content, extension and update operations bind fixed channels', async () => {
  const { calls, exposed } = loadPreloadApi();
  await exposed.aiFree.browser.getSettings({ historyId: 'history-1' });
  await exposed.aiFree.network.switchClashProxy({ name: 'node-a' });
  await exposed.aiFree.content.refreshTutorialUrl();
  await exposed.aiFree.extensions.setEnabled({ id: 'extension-a', enabled: true });
  await exposed.aiFree.updates.start({ version: '2.7.0' });
  exposed.aiFree.ui.requestAccountCenter();
  assert.deepEqual(calls, [
    ['invoke', 'get-ai-free-browser-settings', { historyId: 'history-1' }],
    ['invoke', 'switch-clash-mini-proxy', { name: 'node-a' }],
    ['invoke', 'refresh-tutorial-url', undefined],
    ['invoke', 'set-extension-enabled', { id: 'extension-a', enabled: true }],
    ['invoke', 'start-app-update', { version: '2.7.0' }],
    ['send', 'request-account-center', undefined],
  ]);
  for (const domain of ['browser', 'network', 'content', 'extensions', 'updates', 'ui']) {
    assert.equal(Object.isFrozen(exposed.aiFree[domain]), true);
    assert.equal('invoke' in exposed.aiFree[domain], false);
    assert.equal('send' in exposed.aiFree[domain], false);
    assert.equal('on' in exposed.aiFree[domain], false);
  }
});

test('all sidebar scripts use named aiFree capabilities only', () => {
  const root = path.join(projectRoot, 'src/app/sidebar');
  const pending = [root];
  const files = [];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.name.endsWith('.js')) files.push(target);
    }
  }
  const violations = files.filter((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return /window\.electron(?:API)?\b/.test(source);
  });
  assert.deepEqual(violations, []);
});

test('preload no longer exposes arbitrary-channel compatibility globals', () => {
  const { exposed } = loadPreloadApi();
  assert.equal(exposed.electronAPI, undefined);
  assert.equal(exposed.electron, undefined);
  assert.ok(exposed.aiFree);

  const sourceRoot = path.join(projectRoot, 'src');
  const pending = [sourceRoot];
  const violations = [];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (/\.(?:html|js|ts)$/.test(entry.name)) {
        const source = fs.readFileSync(target, 'utf8');
        if (/window\.electron(?:API)?\b/.test(source)) violations.push(target);
      }
    }
  }
  assert.deepEqual(violations, []);
});
