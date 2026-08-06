'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '../..');

function readSource(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function createButton(textContent = '') {
  return {
    dataset: {},
    disabled: false,
    textContent,
  };
}

function createDomElement() {
  const element = {
    children: [],
    className: '',
    dataset: {},
    disabled: false,
    style: { setProperty() {} },
    addEventListener() {},
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this[name] = String(value); },
    querySelector(selector) {
      const className = selector.startsWith('.') ? selector.slice(1) : '';
      for (const child of this.children) {
        if (String(child.className || '').split(/\s+/).includes(className)) return child;
        const nested = child.querySelector?.(selector);
        if (nested) return nested;
      }
      return null;
    },
  };
  return element;
}

test('自动开启网络魔法在配置获取完成前禁用主开关', async () => {
  let finishStart;
  let startOptions = null;
  const startPending = new Promise((resolve) => { finishStart = resolve; });
  const vpnBtn = createButton('开启网络魔法');
  const startBtn = createButton('启动 Clash Mini');
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    window: {
      aiFree: {
        network: {
          getAutoStartEnabled: async () => ({ ok: true, enabled: true }),
          getClashStatus: async () => ({ running: false }),
        },
        license: {
          getUserCredentials: async () => ({
            ok: true,
            credentials: { key: 'saved-key', deviceId: 'saved-device', validated: true, bound: true },
          }),
        },
      },
    },
    autoStartClashMiniInFlight: false,
    hasValidatedInSession: false,
    isVpnEnabled: false,
    isLicenseValidated: () => false,
    applyVpnActionAvailability: () => {},
    updateClashVpnButton: (button, state) => {
      button.textContent = state.enabled ? '关闭网络魔法' : '开启网络魔法';
    },
  });
  vm.runInContext(
    readSource('src/app/renderer/controllers/shared/controller-utils.js'),
    context,
  );
  context.withBusyButton = context.window.RendererControllerUtils.withBusyButton;
  vm.runInContext(
    readSource('src/app/sidebar/client/app/side/controllers/pages/side-panel/modules/vpn-selector.js'),
    context,
  );
  vm.runInContext(
    readSource('src/app/sidebar/client/app/side/controllers/pages/side-panel/modules/vpn-lifecycle.js'),
    context,
  );
  context.startClashMiniFlow = (options) => { startOptions = options; return startPending; };

  const task = context.autoStartNetworkMagicIfEligible({ startBtn, vpnBtn });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(vpnBtn.disabled, true);
  assert.equal(vpnBtn.dataset.busy, '1');
  assert.equal(vpnBtn.textContent, '正在开启魔法请稍等');
  assert.equal(startOptions.key, 'saved-key');
  assert.equal(startOptions.deviceId, 'saved-device');

  context.updateClashVpnButton(vpnBtn, { enabled: false, isBusy: true });
  assert.equal(vpnBtn.disabled, true);
  assert.equal(vpnBtn.textContent, '正在开启魔法请稍等');

  finishStart();
  await task;
  assert.equal(vpnBtn.disabled, false);
  assert.equal(vpnBtn.dataset.busy, '0');
  assert.equal(vpnBtn.textContent, '开启网络魔法');
});

test('点击开启网络魔法成功后主开关恢复为关闭按钮', async () => {
  const vpnBtn = createButton('开启网络魔法');
  const context = vm.createContext({
    console,
    window: {},
    isVpnEnabled: false,
    updateClashVpnButton: (button, state) => {
      button.textContent = state.enabled ? '关闭网络魔法' : '开启网络魔法';
    },
  });
  vm.runInContext(readSource('src/app/renderer/controllers/shared/controller-utils.js'), context);
  context.withBusyButton = context.window.RendererControllerUtils.withBusyButton;
  vm.runInContext(
    readSource('src/app/sidebar/client/app/side/controllers/pages/side-panel/modules/vpn-lifecycle.js'),
    context,
  );

  await context.withBusyButton(vpnBtn, [], async () => {
    context.isVpnEnabled = true;
  }, context.createVpnBusyButtonOptions());

  assert.equal(vpnBtn.disabled, false);
  assert.equal(vpnBtn.dataset.busy, '0');
  assert.equal(vpnBtn.textContent, '关闭网络魔法');
});

test('侧边栏启动时主动读取并渲染浏览器记录', async () => {
  const listeners = new Map();
  const refreshButton = {
    disabled: false,
    setAttribute() {},
  };
  const historyList = {
    innerHTML: '',
    setAttribute() {},
  };
  let historyReads = 0;
  let renderedHistory = [];
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    window: {
      aiFree: {
        browser: {
          getHistory: async () => {
            historyReads += 1;
            return { ok: true, history: [{ id: 'history-1', name: '浏览器 1' }] };
          },
        },
      },
      createAiFreeBrowserHistoryView: (deps) => ({
        renderBrowserHistory: () => { renderedHistory = deps.getBrowserHistory(); },
        renderBrowserProfileAudit: () => {},
        formatBrowserHistoryDateTime: () => '',
      }),
      bindAiFreeBrowserSettingsEvents: () => {},
    },
    document: {
      documentElement: { classList: { contains: (name) => name === 'browser-settings-page' } },
      addEventListener: (name, listener) => listeners.set(name, listener),
      getElementById: (id) => ({
        'refresh-browser-history': refreshButton,
        'browser-history-list': historyList,
      })[id] || null,
      querySelectorAll: () => [],
    },
  });
  vm.runInContext(
    readSource('src/app/sidebar/client/app/side/controllers/pages/side-panel/modules/browser-settings.js'),
    context,
  );

  listeners.get('DOMContentLoaded')();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(historyReads, 1);
  assert.equal(renderedHistory.length, 1);
  assert.equal(renderedHistory[0].id, 'history-1');
});

test('节点延时重新测速保持按钮可用且不请求自动切换', async () => {
  let finishTest;
  let request = null;
  const pending = new Promise((resolve) => { finishTest = resolve; });
  const retestButton = {
    disabled: false,
    setAttribute() {},
    removeAttribute() {},
  };
  const context = vm.createContext({
    console,
    window: {
      aiFree: {
        network: {
          testMinLatency: async (options) => {
            request = options;
            return pending;
          },
        },
      },
    },
    isVpnEnabled: true,
    testLatencyBtn: retestButton,
    vpnNodeSelectorGrid: null,
    vpnNodeSelectorPanel: null,
    clashMiniProxyState: {
      groupName: 'Manual',
      current: 'A',
      names: ['A', 'B'],
      proxies: [
        { name: 'A', delay: 30, delayText: '30ms', selected: true },
        { name: 'B', delay: 50, delayText: '50ms', selected: false },
      ],
    },
  });
  vm.runInContext(
    readSource('src/app/sidebar/client/app/side/controllers/pages/side-panel/modules/vpn.js'),
    context,
  );
  vm.runInContext(
    readSource('src/app/sidebar/client/app/side/controllers/pages/side-panel/modules/vpn-config.js'),
    context,
  );
  vm.runInContext(
    readSource('src/app/sidebar/client/app/side/controllers/pages/side-panel/modules/vpn-selector.js'),
    context,
  );

  const task = context.retestVpnNodes(['B']);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(retestButton.disabled, false);
  assert.deepEqual(JSON.parse(JSON.stringify(request)), {
    selectBest: false,
    reportProgress: true,
    names: ['B'],
  });

  finishTest({ ok: true, entries: [{ name: 'B', delay: 45 }] });
  await task;
  assert.equal(context.clashMiniProxyState.current, 'A');
});

test('启动流程中切换节点可展开但测速操作保持禁用', () => {
  const toggleButton = createButton('切换节点');
  const retestButton = createButton('重新测速');
  const context = vm.createContext({
    console,
    window: {},
    isVpnEnabled: true,
    vpnNodeSelectorBusy: false,
    clashMiniStartFlowPromise: Promise.resolve(),
    autoStartClashMiniInFlight: false,
    isLicenseValidated: () => true,
    testLatencyBtn: retestButton,
    vpnNodeSelectorToggleBtn: toggleButton,
  });
  vm.runInContext(
    readSource('src/app/sidebar/client/app/side/controllers/pages/side-panel/modules/vpn.js'),
    context,
  );
  vm.runInContext('clashMiniStartFlowPromise = Promise.resolve()', context);

  context.applyVpnActionAvailability();

  assert.equal(toggleButton.disabled, false);
  assert.equal(retestButton.disabled, true);
});

test('节点完整重建后仍显示已测延时', () => {
  const context = vm.createContext({
    console,
    document: { createElement: () => createDomElement() },
    window: {},
    vpnNodeSelectorBusy: false,
  });
  vm.runInContext(
    readSource('src/app/sidebar/client/app/side/controllers/pages/side-panel/modules/vpn.js'),
    context,
  );

  const button = context.buildVpnNodeSelectorButton(
    '节点 A',
    0,
    { name: '节点 A', delay: 88, delayText: '88ms' },
    '节点 A',
  );

  assert.equal(button.querySelector('.vpn-node-option-meta').textContent, '88ms');
  assert.equal(button['aria-checked'], 'true');
});

test('节点测速失败只显示简短 error 状态', () => {
  const context = vm.createContext({
    console,
    window: {},
    vpnNodeSelectorBusy: false,
  });
  vm.runInContext(
    readSource('src/app/sidebar/client/app/side/controllers/pages/side-panel/modules/vpn.js'),
    context,
  );

  const entries = context.normalizeProxyEntries([{
    name: '节点 A',
    delay: null,
    delayText: 'An error occurred in the delay test: request failed with a very long reason',
    error: 'An error occurred in the delay test: request failed with a very long reason',
  }], '');

  assert.equal(entries[0].delayText, 'error');
});

test('设置页自动启动时同步账号会话并解除节点选择登录门禁', async () => {
  let sessionUpdated = null;
  let availabilitySyncs = 0;
  const documentElement = { dataset: {} };
  const context = vm.createContext({
    console,
    document: { documentElement },
    window: {
      aiFree: {
        account: {
          getSession: async () => ({ authenticated: true }),
          onSessionUpdated: (listener) => { sessionUpdated = listener; },
        },
      },
    },
    syncLatencyButtonState: () => { availabilitySyncs += 1; },
    syncLoggedOutProtectedEntryAvailability: () => {},
  });
  vm.runInContext(
    readSource('src/app/sidebar/client/app/side/controllers/pages/side-panel/modules/vpn-lifecycle.js'),
    context,
  );

  context.bindNetworkMagicAccountSession();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(documentElement.dataset.accountAuthenticated, 'true');
  assert.equal(availabilitySyncs, 1);

  sessionUpdated({ authenticated: false });
  assert.equal(documentElement.dataset.accountAuthenticated, 'false');
  assert.equal(availabilitySyncs, 2);
});

test('启动测速前先加载并显示节点，只补测没有历史延时的节点', async () => {
  let finishTest;
  let optionsRequest = null;
  let latencyRequest = null;
  const pending = new Promise((resolve) => { finishTest = resolve; });
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    window: {
      aiFree: {
        network: {
          getClashProxyOptions: async (options) => {
            optionsRequest = options;
            return {
              ok: true,
              groupName: 'Manual',
              current: 'A',
              names: ['A', 'B'],
              proxies: [
                { name: 'A', delay: 31, delayText: '31ms' },
                { name: 'B', delay: null, delayText: '待测速' },
              ],
            };
          },
          testMinLatency: async (options) => {
            latencyRequest = options;
            return pending;
          },
        },
      },
    },
    isVpnEnabled: true,
    testLatencyBtn: null,
    vpnNodeSelectorBusy: false,
    vpnNodeSelectorGrid: null,
    vpnNodeSelectorPanel: null,
    clashMiniProxyState: { groupName: 'Manual', current: '', names: [], proxies: [] },
  });
  vm.runInContext(readSource('src/app/sidebar/client/app/side/controllers/pages/side-panel/modules/vpn.js'), context);
  vm.runInContext(readSource('src/app/sidebar/client/app/side/controllers/pages/side-panel/modules/vpn-config.js'), context);
  vm.runInContext(readSource('src/app/sidebar/client/app/side/controllers/pages/side-panel/modules/vpn-selector.js'), context);

  const task = context.loadVpnNodeSelectorOptions({ force: true, probeDelays: true });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(optionsRequest)), { includeDelays: false });
  assert.deepEqual(JSON.parse(JSON.stringify(context.clashMiniProxyState.names)), ['A', 'B']);
  assert.equal(context.clashMiniProxyState.proxies[0].delay, 31);
  assert.equal(context.clashMiniProxyState.proxies[1].delayText, '测速中...');
  assert.deepEqual(JSON.parse(JSON.stringify(latencyRequest)), {
    selectBest: false,
    reportProgress: true,
    names: ['B'],
  });

  const loaded = await Promise.race([
    task.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 30)),
  ]);
  assert.equal(loaded, true, '节点列表加载不应等待后台测速完成');

  finishTest({ ok: true, entries: [{ name: 'B', delay: 42 }] });
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.clashMiniProxyState.proxies[1].delay, 42);
});

test('独立首页登录门禁读取真实会话，已登录继续操作、未登录请求个人中心', async () => {
  async function runGate(authenticated) {
    let accountCenterRequests = 0;
    const context = vm.createContext({
      console,
      setTimeout,
      clearTimeout,
      document: { documentElement: { dataset: {} }, activeElement: null },
      safeGetEl: () => null,
      window: {
        aiFree: {
          account: { getSession: async () => ({ authenticated }) },
          ui: { requestAccountCenter: () => { accountCenterRequests += 1; } },
        },
      },
    });
    vm.runInContext(
      readSource('src/app/sidebar/client/app/side/controllers/pages/side-panel/modules/account-auth.js'),
      context,
    );
    const redirected = await context.redirectToSidebarAccountLogin();
    return { accountCenterRequests, authenticated: context.document.documentElement.dataset.accountAuthenticated, redirected };
  }

  assert.deepEqual(await runGate(true), {
    accountCenterRequests: 0,
    authenticated: 'true',
    redirected: false,
  });
  assert.deepEqual(await runGate(false), {
    accountCenterRequests: 1,
    authenticated: 'false',
    redirected: true,
  });
});
