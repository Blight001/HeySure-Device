const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const controllerRoot = path.join(
  __dirname,
  '../../src/app/sidebar/client/app/side/controllers/pages/ai-control',
);

function runController(context, file) {
  const source = fs.readFileSync(path.join(controllerRoot, file), 'utf8');
  vm.runInContext(source, context, { filename: file });
}

function createControllerContext(overrides = {}) {
  const context = vm.createContext({
    console,
    setInterval() {},
    setTimeout() {},
    window: {
      addEventListener() {},
      aiFree: {},
      visualViewport: { addEventListener() {} },
    },
    document: {
      addEventListener() {},
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      documentElement: { dataset: {} },
    },
    ...overrides,
  });
  runController(context, '../ai-control.js');
  return context;
}

test('启动只创建新对话，历史加载和账号刷新不会恢复旧会话', async () => {
  let started = 0;
  let restored = 0;
  const context = createControllerContext({
    refreshHistoryList: async () => {},
    startNewConversation: async () => {
      started += 1;
      vm.runInContext("state.currentSession = { id: 'new-session', messages: [] }", context);
    },
    applySession: () => { restored += 1; },
    readLocalHistoryStore: () => ({ currentId: 'old-session' }),
  });
  context.window.aiFree.ai = {
    historyList: async () => ({ ok: true, currentId: 'old-session' }),
    historyGet: async () => ({
      ok: true,
      session: { id: 'old-session', messages: [{ role: 'user', content: '旧对话' }] },
    }),
  };
  runController(context, 'ai-control-bootstrap.js');

  await vm.runInContext('bootstrapHistory()', context);
  assert.equal(started, 1);
  assert.equal(restored, 0);
  assert.equal(vm.runInContext('state.currentSession.id', context), 'new-session');

  await vm.runInContext('bootstrapHistory()', context);
  assert.equal(started, 1);
  assert.equal(restored, 0);
  assert.equal(vm.runInContext('state.currentSession.id', context), 'new-session');
});

test('旧会话的延迟保存结果不会覆盖刚切换的新对话', async () => {
  let resolveSave;
  const context = createControllerContext({
    currentMessages: () => [{ role: 'user', content: '正在保存' }],
    upsertLocalSession() {},
    updateSessionTitleUi() {},
    readLocalHistoryStore: () => ({ sessions: [] }),
    sessionSummaryLocal: (session) => session,
  });
  context.document.getElementById = (id) => (
    id === 'ai-chat-model' ? { value: 'model-a' } : null
  );
  context.window.aiFree.ai = {
    historySave: () => new Promise((resolve) => { resolveSave = resolve; }),
  };
  runController(context, 'ai-control-history-list.js');
  vm.runInContext('refreshHistoryList = async () => {}', context);
  vm.runInContext(`state.currentSession = {
    id: 'old-session', title: '旧对话', messages: [], createdAt: 1
  }`, context);

  const saving = vm.runInContext('persistCurrentSession()', context);
  vm.runInContext(`state.currentSession = {
    id: 'new-session', title: '新对话', messages: [], createdAt: 2
  }; state.messages = []`, context);
  resolveSave({
    ok: true,
    session: { id: 'old-session', title: '旧对话', messages: [{ role: 'user', content: '正在保存' }] },
  });
  await saving;

  assert.equal(vm.runInContext('state.currentSession.id', context), 'new-session');
  assert.equal(vm.runInContext('state.messages.length', context), 0);
});

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.listeners = {};
    this.parentNode = null;
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.dispatched = [];
  }

  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this[name] = value;
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }

  dispatchEvent(event) {
    this.dispatched.push(event.type);
    this.listeners[event.type]?.(event);
  }

  focus() {
    this.focused = true;
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }

  querySelector(selector) {
    const className = selector.startsWith('.') ? selector.slice(1) : '';
    for (const child of this.children) {
      if (className && child.className.split(' ').includes(className)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

test('新对话空白页展示五条最近聊天并可点击切换', () => {
  const messages = new FakeElement('div');
  const welcome = new FakeElement('div');
  welcome.className = 'ai-chat-welcome';
  messages.appendChild(welcome);
  let selectedId = '';
  const context = createControllerContext({
    formatRelativeTime: (value) => `${value}分钟前`,
    loadSessionById: async (id) => { selectedId = id; },
  });
  context.document.getElementById = (id) => (id === 'ai-chat-messages' ? messages : null);
  context.document.createElement = (tagName) => new FakeElement(tagName);
  context.sessions = Array.from({ length: 6 }, (_, index) => ({
    id: `session-${index + 1}`,
    title: `聊天 ${index + 1}`,
    preview: `内容 ${index + 1}`,
    updatedAt: index + 1,
  }));
  runController(context, 'ai-control-history-list.js');
  vm.runInContext("state.currentSession = { id: 'new-session' }; state.sessionList = sessions", context);

  vm.runInContext('renderRecentHistory()', context);
  const recent = welcome.querySelector('.ai-chat-recent');
  const list = welcome.querySelector('.ai-chat-recent-list');
  assert.equal(recent['aria-label'], '最近聊天');
  assert.equal(recent.querySelector('.ai-chat-recent-heading').textContent, '最近聊天');
  assert.equal(recent.querySelector('.ai-chat-recent-heading').children[0].textContent, '5 条');
  assert.equal(list.children.length, 5);
  assert.equal(list.children[0].querySelector('.ai-chat-recent-title').textContent, '聊天 1');
  assert.equal(list.children[0].querySelector('.ai-chat-recent-icon'), null);
  assert.equal(list.children[0].querySelector('.ai-chat-recent-arrow'), null);

  list.children[0].listeners.click();
  assert.equal(selectedId, 'session-1');
});

test('新对话空白页不展示快捷任务入口', () => {
  const messages = new FakeElement('div');
  const context = createControllerContext({
    currentMessages: () => [],
    renderRecentHistory() {},
    updateSessionTitleUi() {},
    selectedAutomationCard: () => null,
  });
  context.document.getElementById = (id) => (id === 'ai-chat-messages' ? messages : null);
  context.document.createElement = (tagName) => new FakeElement(tagName);
  runController(context, 'ai-control-messages.js');
  vm.runInContext('state.currentBrowserIds = []; renderWelcome()', context);

  assert.ok(messages.querySelector('.ai-chat-welcome-hero'));
  assert.equal(messages.querySelector('.ai-chat-prompts'), null);
});
