'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseTextMcpCalls } = require('../../../src/app/main/features/ai-chat/chat-text-mcp-parser');

function parsedCall(source) {
  const result = parseTextMcpCalls(source, 2);
  assert.equal(result.detected, true);
  assert.equal(result.error, '');
  assert.equal(result.toolCalls.length, 1);
  return {
    content: result.content,
    name: result.toolCalls[0].function.name,
    arguments: JSON.parse(result.toolCalls[0].function.arguments),
  };
}

test('兼容标准 mcp-call 与下划线变体', () => {
  assert.deepEqual(parsedCall('准备中<mcp-call>{"tool":"software_window","arguments":{"action":"list"}}</mcp-call>'), {
    content: '准备中', name: 'software_window', arguments: { action: 'list' },
  });
  assert.deepEqual(parsedCall('<mcp_call>{"name":"software_window","args":{"action":"open"}}</mcp_call>'), {
    content: '', name: 'software_window', arguments: { action: 'open' },
  });
});

test('兼容 Anthropic/DSML invoke 的 JSON 与 parameter 参数', () => {
  assert.deepEqual(parsedCall('<invoke name="software_window">{"action":"list"}</invoke>'), {
    content: '', name: 'software_window', arguments: { action: 'list' },
  });
  assert.deepEqual(parsedCall("<invoke name='software_window'><parameter name='action'>open</parameter><parameter name='restart'>true</parameter></invoke>"), {
    content: '', name: 'software_window', arguments: { action: 'open', restart: true },
  });
});

test('兼容 Hermes/Qwen tool_call 与 Grok/xAI function_call', () => {
  assert.deepEqual(parsedCall('<tool_call>{"function":{"name":"software_window","arguments":"{\\"action\\":\\"list\\"}"}}</tool_call>'), {
    content: '', name: 'software_window', arguments: { action: 'list' },
  });
  assert.deepEqual(parsedCall('<xai:function_call name="software_window"><argument name="action">list</argument></xai:function_call>'), {
    content: '', name: 'software_window', arguments: { action: 'list' },
  });
});

test('只把具备工具调用结构的 Markdown JSON fence 当作 MCP 调用', () => {
  assert.deepEqual(parsedCall('```json\n{"tool":"software_window","arguments":{"action":"list"}}\n```'), {
    content: '', name: 'software_window', arguments: { action: 'list' },
  });
  const ordinary = parseTextMcpCalls('```json\n{"answer":42}\n```');
  assert.equal(ordinary.detected, false);
  assert.match(ordinary.content, /"answer":42/);
});

test('已识别外壳的坏 JSON、截断调用和缺失工具名返回格式诊断', () => {
  for (const source of [
    '<tool_call>{bad json}</tool_call>',
    '<mcp-call>{"tool":"software_window","arguments":{',
    '<invoke>{"action":"list"}</invoke>',
    '```tool_call\n{"tool":\n```',
  ]) {
    const result = parseTextMcpCalls(source);
    assert.equal(result.detected, true);
    assert.notEqual(result.error, '');
    assert.match(result.content, /MCP 调用格式错误/);
    assert.deepEqual(result.toolCalls, []);
  }
});
