'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAutomationCardMcpRouter } = require('../../../src/app/main/services/automation-card-mcp-router');

function fixture() {
  const calls = [];
  const connections = [
    { id: 'browser-1', name: '主窗口' },
    { id: 'browser-2', name: '备用窗口' },
  ];
  const definitions = [
    { name: 'browser_action', description: '页面操作', input_schema: { type: 'object' } },
    { name: 'manage_card', description: '卡片管理', input_schema: { type: 'object' } },
  ];
  const windowTools = {
    tools: [{ name: 'run_command', description: '运行命令', input_schema: { type: 'object' } }],
    has: (name) => name === 'run_command',
    execute: async (name, args) => { calls.push(['window', name, args]); return { success: true }; },
  };
  const router = createAutomationCardMcpRouter({
    listConnections: () => connections,
    getConnection: (id) => ({ ...connections.find((item) => item.id === id), tools: definitions }),
    dispatch: async (...args) => { calls.push(['browser', ...args]); return { success: true }; },
  });
  router.configure({ getWindowTools: () => windowTools });
  return { router, calls };
}

test('card MCP router lists current tools but hides recursive card operations', () => {
  const { router } = fixture();
  assert.deepEqual(router.listTools().map((tool) => tool.name), ['run_command', 'browser_action']);
});

test('card MCP router executes software tools without requiring a browser connection', async () => {
  const { router, calls } = fixture();
  await router.execute('', 'run_command', { command: 'echo ok' });
  assert.deepEqual(calls, [['window', 'run_command', { command: 'echo ok' }]]);
});

test('card MCP router reuses browser routing and strips route-only arguments', async () => {
  const { router, calls } = fixture();
  await router.execute('browser-1', 'browser_action', {
    change_browser: '备用窗口', action: 'click', selector: '#submit',
  });
  assert.equal(calls[0][0], 'browser');
  assert.equal(calls[0][1], 'browser-2');
  assert.equal(calls[0][2], 'browser_action');
  assert.deepEqual(calls[0][3], { action: 'click', selector: '#submit' });
});

test('card MCP router rejects recursive manage_card calls', async () => {
  const { router } = fixture();
  await assert.rejects(() => router.execute('browser-1', 'manage_card', { action: 'run' }), /禁止递归调用/);
});
