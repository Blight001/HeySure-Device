'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  fitAiControlContext,
  serializedLength,
} = require('../../../src/app/main/lib/ai-control-context-budget');

test('上下文预算保留系统消息、最近对话和完整工具配对', () => {
  const largeResult = JSON.stringify({ items: '结果'.repeat(10000) });
  const messages = [
    { role: 'system', content: '工具规则' },
    ...Array.from({ length: 18 }, (_, index) => [
      { role: 'user', content: `旧问题-${index}-${'内容'.repeat(500)}` },
      { role: 'assistant', content: `旧回答-${index}-${'结论'.repeat(500)}` },
    ]).flat(),
    {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'call-1', function: { name: 'browser_observe', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call-1', name: 'browser_observe', content: largeResult },
    { role: 'user', content: '根据刚才的结果继续' },
  ];
  const original = structuredClone(messages);
  const tools = [{ name: 'browser_observe', input_schema: { type: 'object' } }];
  const fitted = fitAiControlContext(messages, tools, { maxRequestChars: 18000, toolResultChars: 4000 });

  assert.ok(serializedLength(fitted, tools) <= 18000);
  assert.equal(fitted[0].role, 'system');
  assert.match(fitted[1].content, /较早对话摘要/);
  assert.equal(fitted.at(-1).content, '根据刚才的结果继续');
  const assistant = fitted.find((message) => message.tool_calls?.[0]?.id === 'call-1');
  const tool = fitted.find((message) => message.tool_call_id === 'call-1');
  assert.ok(assistant);
  assert.ok(tool);
  assert.match(tool.content, /已截短/);
  assert.deepEqual(messages, original, '发送副本的压缩不应破坏持久化历史');
});

test('未超预算时不改写普通对话', () => {
  const messages = [
    { role: 'system', content: '规则' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好，有什么可以帮你？' },
  ];
  assert.deepEqual(fitAiControlContext(messages, []), messages);
});

test('模型请求不重复携带仅用于 UI 重建的思考和工具时间线', () => {
  const fitted = fitAiControlContext([{
    role: 'assistant',
    content: '最终答案',
    reasoning: '内部思考',
    tool_events: [{ id: 'tool-1', result: '大量展示数据' }],
    trace_events: [{ type: 'reasoning', content: '内部思考' }],
  }], []);

  assert.deepEqual(fitted, [{ role: 'assistant', content: '最终答案' }]);
});
