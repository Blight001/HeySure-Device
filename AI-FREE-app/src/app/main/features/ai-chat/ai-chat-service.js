'use strict';

const { createAiBrowserWindowTools } = require('../../services/ai-browser-window-tools');
const { createAiSandboxFileTools } = require('../../services/ai-sandbox-file-tools');
const { createChatRunRegistry } = require('./chat-run-registry');
const { prepareChatRequest } = require('./chat-request-context');
const { runChatConversation } = require('./chat-conversation-runner');
const { enrichBrowserConnectionNames } = require('./connection-names');
const { clonePromptValue, createPromptDiagnostics } = require('./chat-prompt-diagnostics');

function namedBrowserConnections(deps) {
  const bridge = deps.browserAutomationBridge;
  const connections = (bridge?.listConnections?.() || [])
    .map((item) => bridge.getConnection?.(item.id))
    .filter(Boolean);
  return enrichBrowserConnectionNames(
    connections,
    typeof deps.getTabs === 'function' ? deps.getTabs() : [],
    deps.browserRuntimeManager?.listStates?.() || [],
  );
}

async function waitForBrowserConnection(deps, target = {}, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  const wantedName = String(target.name || '').trim().toLowerCase();
  const wantedProfile = String(target.tabId || target.profileId || '').trim();
  do {
    const found = namedBrowserConnections(deps).find((item) => (
      (wantedProfile && String(item.profileId || '') === wantedProfile)
      || (wantedName && String(item.name || '').trim().toLowerCase() === wantedName)
    ));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return null;
}

function createAiChatService(deps = {}) {
  const {
    readStoreConfigSafe,
    licenseCache,
    logger = console,
  } = deps;
    const chatRuns = createChatRunRegistry();
    let lastPromptRequest = null;

    // 软件端默认的“外层”浏览器窗口控制工具与 Chromium 原生连接分别管理窗口和页面，
    // 每次对话都会注入，让 AI 能列出/打开/新建/重命名/关闭软件的浏览器窗口。
    let aiBrowserWindowTools = null;
    const getAiBrowserWindowTools = () => {
      if (aiBrowserWindowTools) return aiBrowserWindowTools;
      if (!deps.browserWindowUi) return null;
      try {
        const windowTools = createAiBrowserWindowTools({
          ui: deps.browserWindowUi,
          licenseCache,
          logger,
          waitForBrowserConnection: (target) => waitForBrowserConnection(deps, target),
        });
        const fileTools = createAiSandboxFileTools({ sandboxDir: deps.aiSandboxDir });
        aiBrowserWindowTools = {
          tools: [...windowTools.tools, ...fileTools.tools],
          has: (name) => windowTools.has(name) || fileTools.has(name),
          execute: (name, args) => (windowTools.has(name)
            ? windowTools.execute(name, args)
            : fileTools.execute(name, args)),
        };
      } catch (error) {
        logger.warn?.('[AI窗口工具] 初始化失败:', error?.message || error);
      }
      return aiBrowserWindowTools;
    };

    async function insert(_event, input = {}) {
      const requestId = String(input.requestId || '').trim();
      const content = String(input.content || '').trim();
      if (!requestId || !content) return { ok: false, message: '缺少要插入的对话内容' };
      return chatRuns.insert(_event, requestId, content);
    }

    async function stop(_event, input = {}) {
      const requestId = String(input.requestId || '').trim();
      return chatRuns.stop(_event, requestId);
    }

    async function chat(_event, input = {}) {
      let activeRun = null;
      let activeRunKey = '';
      try {
        const request = prepareChatRequest(deps, _event, input, chatRuns, getAiBrowserWindowTools);
        request.capturePromptSnapshot = (snapshot) => {
          lastPromptRequest = clonePromptValue(snapshot);
        };
        activeRunKey = request.key || '';
        activeRun = request.run || null;
        if (request.error) return request.error;
        return await runChatConversation(request, readStoreConfigSafe);
      } catch (error) {
        if (activeRun?.stopped || error?.name === 'AbortError' || error?.code === 'ERR_CANCELED') {
          return { ok: true, stopped: true, messages: [], message: { role: 'assistant', content: '' } };
        }
        return { ok: false, message: error?.message || String(error) };
      } finally {
        chatRuns.finish(activeRunKey, activeRun);
      }
    }

    function getPromptDiagnostics(_event, input = {}) {
      return createPromptDiagnostics(
        deps, input, getAiBrowserWindowTools, lastPromptRequest,
      );
    }

    return { chat, getPromptDiagnostics, getWindowTools: getAiBrowserWindowTools, insert, stop };
}

module.exports = { createAiChatService, namedBrowserConnections, waitForBrowserConnection };
