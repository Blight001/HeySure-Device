const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function readController(name) {
  return fs.readFileSync(path.join(
    __dirname,
    '../../src/app/sidebar/client/app/side/controllers/pages/ai-control',
    name,
  ), 'utf8');
}

function createClassList() {
  const values = new Set();
  return {
    contains: (value) => values.has(value),
    toggle(value, enabled) {
      if (enabled) values.add(value);
      else values.delete(value);
    },
  };
}

function createFixture() {
  const handlers = {};
  const form = { addEventListener: (type, handler) => { handlers[type] = handler; } };
  const input = { value: '' };
  const model = { value: 'model-a' };
  const send = {
    classList: createClassList(), dataset: {}, disabled: false, innerHTML: '', title: '',
    setAttribute(name, value) { this[name] = value; },
  };
  const elements = { 'ai-chat-form': form, 'ai-chat-input': input, 'ai-chat-model': model, 'ai-chat-send': send };
  const calls = [];
  const context = vm.createContext({
    console,
    document: { addEventListener() {} },
    window: { addEventListener() {}, setTimeout, setInterval() {}, visualViewport: null },
    elements,
    calls,
  });
  vm.runInContext(`
    const state = { loading: true, stopping: false, accountAuthenticated: false };
    const SEND_BUTTON_ICONS = { send: 'send-icon', stop: 'stop-icon' };
    const el = (id) => elements[id] || null;
    function selectedModelIsCustom() { return false; }
    function isQuotaExhausted() { return false; }
    function sendMessage() { calls.push('send'); }
    function stopAIOutput() { calls.push('stop'); }
  `, context);
  vm.runInContext(readController('ai-control-messages.js'), context);
  vm.runInContext(readController('ai-control-bootstrap.js'), context);
  vm.runInContext('bindChatForm()', context);
  return { calls, context, handlers, input, send };
}

test('生成中无草稿时主按钮停止输出，有草稿时切换为插入发送', () => {
  const fixture = createFixture();

  vm.runInContext('syncSendState()', fixture.context);
  assert.equal(fixture.send.dataset.iconMode, 'stop');
  assert.equal(fixture.send['aria-label'], '停止 AI 输出');
  assert.equal(fixture.send.classList.contains('is-stop'), true);
  fixture.handlers.submit({ preventDefault() {} });

  fixture.input.value = '补充这个条件';
  vm.runInContext('syncSendState()', fixture.context);
  assert.equal(fixture.send.dataset.iconMode, 'send');
  assert.equal(fixture.send['aria-label'], '插入当前对话');
  assert.equal(fixture.send.classList.contains('is-stop'), false);
  assert.equal(fixture.send.classList.contains('is-insert'), true);
  fixture.handlers.submit({ preventDefault() {} });

  assert.deepEqual(fixture.calls, ['stop', 'send']);
});
