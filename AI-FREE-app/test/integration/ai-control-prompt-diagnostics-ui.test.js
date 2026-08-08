'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const controllerPath = path.join(
  __dirname,
  '../../src/app/sidebar/client/app/side/controllers/pages/ai-control/ai-control-prompt-diagnostics.js',
);

function createFixture() {
  const elements = Object.fromEntries([
    'ai-prompt-full-content', 'ai-prompt-request-metrics', 'ai-prompt-mcp-functions-content',
    'ai-prompt-tools-content', 'ai-prompt-diagnostics-status',
  ].map((id) => [id, { textContent: '' }]));
  const buttons = ['actual', 'preview'].map((view) => ({
    dataset: { aiPromptView: view },
    setAttribute(name, value) { this[name] = value; },
  }));
  const context = vm.createContext({
    console,
    document: { querySelectorAll: () => buttons },
    elements,
  });
  vm.runInContext('const el = (id) => elements[id] || null;', context);
  vm.runInContext(fs.readFileSync(controllerPath, 'utf8'), context, { filename: controllerPath });
  return { buttons, context, elements };
}

test('Prompt 诊断分开显示实际请求与下次预览', () => {
  const fixture = createFixture();
  const actual = { messages: [{ role: 'user', content: '已发送' }], tools: [{ name: 'windows_tab' }] };
  const preview = { messages: [{ role: 'user', content: '待发送' }], tools: [] };
  fixture.context.result = { lastRequest: actual, preview, mcpTools: [] };

  vm.runInContext('renderPromptDiagnostics(result)', fixture.context);
  assert.deepEqual(JSON.parse(fixture.elements['ai-prompt-full-content'].textContent), actual);
  assert.match(fixture.elements['ai-prompt-request-metrics'].textContent, /1 条消息 · 1 个工具/);
  assert.doesNotMatch(fixture.elements['ai-prompt-full-content'].textContent, /待发送/);

  vm.runInContext("selectPromptDiagnosticsView('preview')", fixture.context);
  assert.deepEqual(JSON.parse(fixture.elements['ai-prompt-full-content'].textContent), preview);
  assert.equal(fixture.buttons[1]['aria-selected'], 'true');
});
