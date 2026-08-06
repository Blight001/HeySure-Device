const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_AI_CONTROL_MCP_CALL_LIMIT,
  getAiControlMcpCallLimit,
  normalizeAiControlMcpCallLimit,
} = require('../../src/app/main/utils/ai-control-settings');

test('AI 控制 MCP 调用上限默认值为 100 并限制到安全范围', () => {
  assert.equal(DEFAULT_AI_CONTROL_MCP_CALL_LIMIT, 100);
  assert.equal(getAiControlMcpCallLimit({}), 100);
  assert.equal(getAiControlMcpCallLimit({ aiControlSettings: { mcpCallLimit: 250 } }), 250);
  assert.equal(normalizeAiControlMcpCallLimit(0), 1);
  assert.equal(normalizeAiControlMcpCallLimit(1001), 1000);
  assert.equal(normalizeAiControlMcpCallLimit('12.8'), 12);
});
