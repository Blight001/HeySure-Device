'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  addBrowserRouteToSchema,
  findConnectionByReference,
  normalizeToolError,
  normalizeToolSchema,
  resolveBrowserConnection,
  resolveDispatchTimeout,
  sanitizeBrowserRoutingArgs,
} = require('../../../src/app/main/services/automation-tool-contract');

test('统一工具契约兼容本地 AI 与外部网关的 schema 字段', () => {
  const local = normalizeToolSchema({
    input_schema: {
      type: 'object',
      properties: { action: { type: 'string' } },
      required: ['action'],
    },
  });
  const external = normalizeToolSchema({
    inputSchema: {
      properties: { action: { type: 'string' } },
      required: ['action'],
    },
  });
  assert.deepEqual(external, local);
  const routed = addBrowserRouteToSchema({ input_schema: local });
  assert.deepEqual(routed.required, ['action']);
  assert.equal(routed.properties.change_browser.type, 'string');
  assert.equal(local.properties.change_browser, undefined);
});

test('统一浏览器路由优先连接 ID 并诊断重名和离线目标', () => {
  const connections = [
    { id: 'one', name: '工作窗口' },
    { id: 'two', browserName: '资料窗口' },
    { id: 'three', pluginName: '资料窗口' },
  ];
  assert.equal(findConnectionByReference(connections, 'one').connection.id, 'one');
  assert.equal(findConnectionByReference(connections, '工作窗口').connection.id, 'one');
  assert.equal(findConnectionByReference(connections, '资料窗口').kind, 'ambiguous');
  assert.equal(findConnectionByReference(connections, 'missing').kind, 'not_found');
  assert.equal(resolveBrowserConnection(connections, {}, 'two').connection.id, 'two');
  assert.equal(resolveBrowserConnection([], {}).kind, 'unavailable');
});

test('统一调用规则清理路由参数并限制工具超时', () => {
  assert.deepEqual(sanitizeBrowserRoutingArgs({
    change_browser: 'one',
    browser_id: 'legacy',
    action: 'click',
  }), { action: 'click' });
  assert.equal(resolveDispatchTimeout('browser_action', {}), 180000);
  assert.equal(resolveDispatchTimeout('manage_card', { action: 'run' }), 900000);
  assert.equal(resolveDispatchTimeout('browser_wait', { timeout_seconds: 9999 }), 1800000);
  assert.deepEqual(normalizeToolError({
    message: '连接已断开',
    errorCode: 'BROWSER_CONNECTION_CLOSED',
    phase: 'bridge_connection',
    recoverable: true,
  }), {
    code: 'BROWSER_CONNECTION_CLOSED',
    message: '连接已断开',
    phase: 'bridge_connection',
    retryable: true,
  });
});
