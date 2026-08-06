const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const composerPath = path.join(
  __dirname,
  '../../src/app/sidebar/client/app/side/controllers/pages/ai-control/ai-control-composer.js',
);

function createComposerFixture(chatResult) {
  const input = { value: '保留这条消息', style: {}, scrollHeight: 24, focus() {} };
  const select = { value: 'model-a' };
  const persisted = [];
  const events = [];
  const streamView = {
    row: { remove() {} },
    addReasoning() {},
    addContent() {},
    replaceContent() {},
    upsertTool() {},
    setContent(value) { this.content = value; },
    finalize() { this.finalized = true; },
  };
  const context = vm.createContext({
    console,
    window: {
      setTimeout,
      aiFree: {
        account: { getSession: async () => ({ authenticated: true }) },
        ai: {
          getModels: async () => ({ quota: { unlimited: true } }),
          onChatEvent: () => () => {},
          chat: async () => {
            events.push('chat');
            return chatResult;
          },
        },
      },
    },
  });
  context.input = input;
  context.select = select;
  context.persisted = persisted;
  context.events = events;
  context.streamView = streamView;
  vm.runInContext(`
    const state = {
      messages: [], currentSession: null, currentBrowserIds: [], currentCardId: '',
      loading: false, stopping: false, activeRequestId: '', accountAuthenticated: false,
      quota: null, lastQuotaCost: null,
    };
    const el = (id) => id === 'ai-chat-input' ? input : (id === 'ai-chat-model' ? select : null);
    function currentMessages() { return state.messages; }
    function selectedModelIsCustom() { return false; }
    function ensureSessionForSend() {
      state.currentSession ||= { id: 'session-a', title: '新对话', createdAt: 1 };
      return state.currentSession;
    }
    function appendMessage() { return {}; }
    function updateSessionTitleUi() {}
    function resizeInput() {}
    function flushDeferredAiControlRefresh() {}
    function syncSendState() {}
    function provisionalTitle(value) { return String(value); }
    function persistCurrentSession() {
      persisted.push(JSON.parse(JSON.stringify(state.messages)));
      events.push('persist');
      return Promise.resolve();
    }
    function createAssistantView() { return streamView; }
    function renderQuota(value) { state.quota = value; }
    function isQuotaExhausted() { return false; }
    function isQuotaFailure() { return false; }
    function showChatBusinessError() {}
    function setStatus(value) { state.status = value; }
    function renderConversation() {}
    function maybeGenerateTitle() {}
  `, context);
  vm.runInContext(fs.readFileSync(composerPath, 'utf8'), context, { filename: composerPath });
  return { context, events, persisted, streamView };
}

test('用户消息先保存再请求 AI，服务失败也保留用户消息和错误记录', async () => {
  const fixture = createComposerFixture({ ok: false, message: '服务器暂时不可用' });

  await vm.runInContext('sendMessage()', fixture.context);

  assert.deepEqual(fixture.events.slice(0, 2), ['persist', 'chat']);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.persisted[0])), [{ role: 'user', content: '保留这条消息' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.persisted.at(-1))), [
    { role: 'user', content: '保留这条消息' },
    { role: 'assistant', content: '请求失败：服务器暂时不可用' },
  ]);
  assert.equal(fixture.streamView.content, '请求失败：服务器暂时不可用');
  assert.equal(fixture.streamView.finalized, true);
});
