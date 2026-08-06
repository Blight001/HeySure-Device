'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { limitAiControlMessages } = require('../../src/app/main/lib/ai-control-message-window');

test('AI 控制保留超过 40 条的完整对话和大段内容', () => {
  const messages = Array.from({ length: 150 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `message-${index}-${'内容'.repeat(500)}`,
  }));
  assert.deepEqual(limitAiControlMessages(messages), messages);
});

test('完整工具调用链和大工具结果原样保留', () => {
  const messages = [
    { role: 'user', content: '检查网页' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call-large', function: { name: 'observe', arguments: '{}' } }],
    },
    { role: 'tool', name: 'observe', tool_call_id: 'call-large', content: '结果'.repeat(30000) },
  ];
  assert.deepEqual(limitAiControlMessages(messages), messages);
});

test('孤立工具结果不发送，不完整工具调用只保留可读文本', () => {
  const validated = limitAiControlMessages([
    { role: 'tool', tool_call_id: 'missing', content: '{"success":false}' },
    {
      role: 'assistant',
      content: '仍可阅读的回复',
      tool_calls: [{ id: 'unreturned', function: { name: 'observe', arguments: '{}' } }],
    },
    { role: 'user', content: '继续' },
  ]);
  assert.deepEqual(validated, [
    { role: 'assistant', content: '仍可阅读的回复' },
    { role: 'user', content: '继续' },
  ]);
});
