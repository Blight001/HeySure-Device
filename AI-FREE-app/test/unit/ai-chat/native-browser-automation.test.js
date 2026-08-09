'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createNativeBrowserAutomation } = require('../../../src/app/main/services/native-browser-automation');

function fixture() {
  const calls = [];
  const downloads = [];
  let automationHandler = null;
  let listedTabs = {
    success: true, action: 'list', count: 1, activeTabId: '0',
    activeTab: { id: '0', index: 0, active: true, title: '首次页面', url: 'https://first.example/' },
    tabs: [{ id: '0', index: 0, active: true, title: '首次页面', url: 'https://first.example/' }],
  };
  const runtime = {
    listStates: () => [{
      profileId: 'profile-a', pid: 42, status: 'ready', bridgeConnected: true,
      startedAt: 100, lastHeartbeatAt: 200,
    }],
    dispatchAutomationByProcessId: async (...args) => {
      calls.push(['automation', ...args]);
      if (automationHandler) return automationHandler(...args);
      if (args[1] === 'list-tabs') return { result: listedTabs };
      if (args[1] === 'get-session-data') return { result: {
        success: true, url: 'http://127.0.0.1:4173/', cookies: [{ name: 'sid', value: 'test' }],
      } };
      if (args[1] === 'activate-tab') {
        return { result: { id: '1', index: 1, active: true, title: '目标页面', url: args[2].url } };
      }
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
    browserDownloadService: {
      execute: async (args, context) => {
        downloads.push({ args, context });
        return { success: true, action: args.action };
      },
      resolveUploadPaths: (paths) => paths,
    },
  });
  return {
    calls,
    downloads,
    service,
    setAutomationHandler: (handler) => { automationHandler = handler; },
    setListedTabs: (value) => { listedTabs = value; },
  };
}

test('native automation publishes ready managed Chromium as the browser connection', () => {
  const { service } = fixture();
  const connections = service.listConnections();
  assert.equal(connections.length, 1);
  assert.equal(connections[0].id, 'native:profile-a');
  assert.equal(connections[0].name, '工作浏览器');
  assert.equal(connections[0].platform, 'ai-free-chromium-native');
  const tools = service.getConnection(connections[0].id).tools;
  assert.equal(tools.length, 7);
  assert.equal(tools.some((tool) => tool.name === 'browser_file'), true);
  assert.equal(tools.some((tool) => tool.name === 'browser_download'), false);
  assert.equal(
    tools.find((tool) => tool.name === 'browser_action').input_schema.properties.action.enum.includes('upload_file'),
    false,
  );
  const tabProperties = tools.find((tool) => tool.name === 'browser_tab').input_schema.properties;
  assert.equal(tabProperties.id.type, 'string');
  assert.equal(tabProperties.index.type, 'number');
  const actionProperties = tools.find((tool) => tool.name === 'browser_action').input_schema.properties;
  assert.equal(actionProperties.ctrl.type, 'boolean');
  assert.equal(actionProperties.meta.type, 'boolean');
  assert.equal(actionProperties.x.type, 'number');
  assert.equal(actionProperties.y.type, 'number');
  assert.equal(actionProperties.to_x.type, 'number');
  assert.equal(actionProperties.to_y.type, 'number');
  assert.equal(actionProperties.start.type, 'number');
  assert.equal(actionProperties.end.type, 'number');
  assert.equal(actionProperties.repeat.type, 'number');
  assert.equal(actionProperties.action.enum.includes('drag'), true);
  assert.equal(actionProperties.action.enum.includes('insert_text'), true);
  assert.equal(actionProperties.action.enum.includes('set_selection'), true);
});

test('browser_file download uses the active page as the trusted relative URL context', async () => {
  const { calls, downloads, service } = fixture();
  await service.dispatch('native:profile-a', 'browser_file', {
    action: 'download', url: '/og.png', page_url: 'http://spoofed.invalid/',
  });
  assert.deepEqual(calls[0], ['automation', 42, 'get-session-data', {}]);
  assert.equal(downloads[0].args.page_url, 'http://127.0.0.1:4173/');
  assert.equal(downloads[0].args.referer, 'http://127.0.0.1:4173/');
  assert.deepEqual(downloads[0].context, { pageUrl: 'http://127.0.0.1:4173/' });
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

test('observed refs click the validated exposed point instead of re-querying a generic selector', async () => {
  const { calls, service, setAutomationHandler } = fixture();
  setAutomationHandler(async (_pid, command) => ({ result: command === 'observe-page' ? {
    success: true,
    items: [{
      id: 'e1', selector: 'button', x: 120, y: 40, width: 80, height: 30,
      clickX: 126, clickY: 46,
    }],
  } : { success: true } }));
  await service.dispatch('native:profile-a', 'browser_observe', { limit: 5 });
  await service.dispatch('native:profile-a', 'browser_action', { action: 'click', ref: 'e1' });
  assert.deepEqual(calls[1], ['automation', 42, 'perform-action', {
    action: 'click', ref: 'e1', selector: 'button', x: 126, y: 46,
  }]);
});

test('explicit text coordinates override an observed ref center while retaining its selector', async () => {
  const { calls, service, setAutomationHandler } = fixture();
  setAutomationHandler(async (_pid, command) => ({ result: command === 'observe-page' ? {
    success: true,
    items: [{
      id: 'e1', selector: 'textarea', x: 120, y: 40, width: 300, height: 80,
      clickX: 126, clickY: 46,
    }],
  } : { success: true } }));
  await service.dispatch('native:profile-a', 'browser_observe', { limit: 5 });
  await service.dispatch('native:profile-a', 'browser_action', {
    action: 'click', ref: 'e1', x: 260, y: 75,
  });
  assert.deepEqual(calls[1], ['automation', 42, 'perform-action', {
    action: 'click', ref: 'e1', selector: 'textarea', x: 260, y: 75,
  }]);
});

test('native tab and session operations do not enqueue extension tasks', async () => {
  const { calls, service } = fixture();
  await service.dispatch('native:profile-a', 'browser_tab', { action: 'replace', url: 'example.org' });
  await service.dispatch('native:profile-a', 'browser_file', { action: 'save_session' });
  assert.deepEqual(calls[0], ['navigate', 'profile-a', 'chromium', 'https://example.org/']);
  assert.deepEqual(calls[1], ['automation', 42, 'get-session-data', {}]);
});

test('browser_tab list reads the live Chromium tab strip on every call', async () => {
  const { calls, service, setListedTabs } = fixture();
  const first = await service.dispatch('native:profile-a', 'browser_tab', { action: 'list' });
  setListedTabs({
    success: true, action: 'list', count: 2, activeTabId: '1',
    activeTab: { id: '1', index: 1, active: true, title: '当前页面', url: 'https://current.example/' },
    tabs: [
      { id: '0', index: 0, active: false, title: '首次页面', url: 'https://first.example/' },
      { id: '1', index: 1, active: true, title: '当前页面', url: 'https://current.example/' },
    ],
  });
  const current = await service.dispatch('native:profile-a', 'browser_tab', { action: 'list' });
  assert.equal(first.activeTab.url, 'https://first.example/');
  assert.equal(current.activeTab.url, 'https://current.example/');
  assert.equal(current.count, 2);
  assert.deepEqual(calls.map((call) => call.slice(0, 3)), [
    ['automation', 42, 'list-tabs'],
    ['automation', 42, 'list-tabs'],
  ]);
});

test('browser_tab switch activates the matching Chromium tab instead of only focusing the window', async () => {
  const { calls, service } = fixture();
  const url = 'http://127.0.0.1:4173/exam-assets/meeting-brief.html';
  const switched = await service.dispatch('native:profile-a', 'browser_tab', { action: 'switch', url });
  assert.deepEqual(switched, {
    success: true, action: 'switch', id: '1', index: 1, active: true, title: '目标页面', url,
  });
  assert.deepEqual(calls, [
    ['automation', 42, 'activate-tab', { url, index: -1 }],
    ['focus', 'profile-a', 'chromium'],
  ]);
});

test('browser_file owns uploads and browser_action rejects the removed upload action', async () => {
  const { calls, service } = fixture();
  const uploaded = await service.dispatch('native:profile-a', 'browser_file', {
    action: 'upload', path: 'C:/workspace/report.txt', selector: 'input[type=file]', page_url: 'https://example.com/',
  });
  assert.equal(uploaded.action, 'upload');
  assert.equal(calls[0][0], 'files');
  assert.equal(calls[1][2], 'perform-action');
  await assert.rejects(
    service.dispatch('native:profile-a', 'browser_action', { action: 'upload_file', path: 'report.txt' }),
    /browser_file action=upload/,
  );
});

test('browser_wait reacquires the active page after a timed-out document attempt', async () => {
  const { calls, service, setAutomationHandler } = fixture();
  let attempts = 0;
  setAutomationHandler(async (_pid, command) => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error('旧页面已销毁');
      error.code = 'INPUT_TARGET_UNAVAILABLE';
      throw error;
    }
    return { result: attempts === 2
      ? { success: false, action: 'wait', error: '等待元素超时', errorCode: 'WAIT_TIMEOUT' }
      : { success: true, action: 'wait', found: true } };
  });

  const result = await service.dispatch('native:profile-a', 'browser_wait', {
    selector: '#mail-send-status', timeout_ms: 5000,
  });

  assert.equal(result.success, true);
  assert.equal(attempts, 3);
  assert.equal(calls[0][2], 'perform-action');
  assert.equal(calls[0][3].timeout_ms, 750);
  assert.equal(calls[2][3].selector, '#mail-send-status');
});

test('browser_wait reports selector and total timeout after all attempts expire', async () => {
  const { service, setAutomationHandler } = fixture();
  setAutomationHandler(async () => ({
    result: { success: false, action: 'wait', error: '等待元素超时', errorCode: 'WAIT_TIMEOUT' },
  }));

  const result = await service.dispatch('native:profile-a', 'browser_wait', {
    selector: '#missing', timeout_ms: 100,
  });

  assert.deepEqual(result, {
    success: false,
    action: 'wait',
    error: '等待元素超时: #missing',
    errorCode: 'WAIT_TIMEOUT',
    selector: '#missing',
    timeout_ms: 100,
  });
});
