'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  summarizeMcpTools,
} = require('../../../src/app/main/features/ai-chat/chat-prompt-diagnostics');

test('MCP 功能摘要包含用途、操作和状态修改属性', () => {
  const summary = summarizeMcpTools([
    {
      name: 'windows_tab',
      description: '管理外部软件栏目',
      destructive: true,
      input_schema: {
        properties: { action: { enum: ['list', 'open', 'close'] } },
      },
    },
    {
      name: 'browser_observe',
      description: '观察当前页面',
      inputSchema: { properties: {} },
    },
  ]);

  assert.deepEqual(summary, [
    {
      name: 'windows_tab',
      description: '管理外部软件栏目',
      actions: ['list', 'open', 'close'],
      destructive: true,
    },
    {
      name: 'browser_observe',
      description: '观察当前页面',
      actions: [],
      destructive: false,
    },
  ]);
});
