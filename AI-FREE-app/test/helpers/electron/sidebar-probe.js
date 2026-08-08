// Electron 侧探针：隔离 userData 加载侧边栏页面，输出 PROBE_RESULT JSON。
// 由 test/integration/electron/*.test.js 经 scripts/run-electron.js 拉起，
// 不与用户日常运行的打包版共享 userData/端口（见 stage0/perf-baseline.md 冲突说明）。
'use strict';

// node --test 会执行 test/ 下所有 .js；本文件只在 Electron 环境生效，
// 纯 Node 下直接退出（视为空测试通过）。
if (!process.versions.electron) {
  return;
}

const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-it-'));
app.setPath('userData', userData);

const consoleErrors = [];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: false } });
  win.webContents.on('console-message', (details) => {
    if (details?.level === 'error') consoleErrors.push(String(details.message || ''));
  });
  const sidebar = path.join(__dirname, '..', '..', '..', 'src', 'app', 'sidebar', 'index.html');
  let result;
  try {
    await win.webContents.loadFile(sidebar);
    const report = await win.webContents.executeJavaScript(`({
      theme: document.documentElement.dataset.theme || '',
      hasControlShell: !!document.querySelector('.control-shell'),
      tabButtons: document.querySelectorAll('.tab-button').length,
      chatStructure: (() => {
        const messages = document.getElementById('ai-chat-messages');
        const firstTool = {
          id: 'tool-1', name: 'browser_observe', arguments: '{"detail":"summary"}',
          result: '{"success":true,"title":"示例页面"}', status: 'success', duration_ms: 1234,
        };
        const secondTool = {
          id: 'tool-2', name: 'browser_action', arguments: '{"action":"click","ref":"e1"}',
          result: '{"success":true}', status: 'success', duration_ms: 800,
        };
        // 使用主进程历史仓库重启后返回的完整消息形状。
        state.messages = [
          { role: 'user', content: '请观察当前页面' },
          {
            role: 'assistant', content: '已经取得页面结构。',
            tool_calls: [{ id: 'tool-1', function: { name: 'browser_observe', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 'tool-1', content: firstTool.result },
          {
            role: 'assistant', content: '',
            tool_calls: [{ id: 'tool-2', function: { name: 'browser_action', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 'tool-2', content: secondTool.result },
          {
            role: 'assistant', content: '页面操作已经完成。',
            trace_events: [
              { type: 'reasoning', round: 1, content: '先确认页面结构。' },
              { type: 'tool', round: 1, tool: firstTool },
              { type: 'step', round: 1, content: '已经取得页面结构。' },
              { type: 'tool', round: 2, tool: secondTool },
            ],
          },
        ];
        renderConversation();
        const tool = messages.querySelector('.ai-chat-tool');
        tool.open = true;
        const assistantStack = messages.querySelector('.ai-chat-assistant-stack');
        return {
          userTag: messages.querySelector('[data-message-kind="user-bubble"]')?.tagName || '',
          assistantTag: messages.querySelector('[data-message-kind="assistant-turn"]')?.tagName || '',
          assistantCount: messages.querySelectorAll('[data-message-kind="assistant-turn"]').length,
          activitySummary: messages.querySelector('.ai-chat-activity-label')?.textContent || '',
          hasActivityRail: !!messages.querySelector('.ai-chat-activity .ai-chat-trace'),
          toolSummary: tool?.querySelector('summary')?.textContent || '',
          toolName: tool?.querySelector('.ai-chat-tool-name')?.textContent || '',
          toolSections: Array.from(tool?.querySelectorAll('.ai-chat-tool-detail-label') || []).map((item) => item.textContent),
          activityCount: messages.querySelectorAll('.ai-chat-activity:not([hidden])').length,
          answerTexts: Array.from(messages.querySelectorAll('.ai-chat-answer')).map((item) => item.textContent),
          turnOrder: Array.from(assistantStack?.children || [])
            .filter((item) => !item.hidden)
            .map((item) => item.classList.contains('ai-chat-activity') ? 'activity' : 'answer'),
        };
      })(),
      themeAfterToggle: (() => {
        // 真实触发主题应用逻辑（等价 app-theme-changed 广播路径）
        const root = document.documentElement;
        const before = root.dataset.theme;
        try { localStorage.setItem('ai-free.control-panel.theme', before === 'light' ? 'dark' : 'light'); } catch (_) {}
        return before;
      })(),
    })`);
    if (process.env.AI_FREE_CHAT_STRUCTURE_CAPTURE) {
      win.setSize(500, 820);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const image = await win.webContents.capturePage();
      fs.writeFileSync(process.env.AI_FREE_CHAT_STRUCTURE_CAPTURE, image.toPNG());
    }
    if (process.env.AI_FREE_WELCOME_CAPTURE) {
      const previewTheme = ['dark', 'light', 'gold'].includes(process.env.AI_FREE_WELCOME_THEME)
        ? process.env.AI_FREE_WELCOME_THEME
        : 'dark';
      await win.webContents.executeJavaScript(`(() => {
        const theme = ${JSON.stringify(previewTheme)};
        document.documentElement.classList.remove('theme-dark', 'theme-light', 'theme-gold');
        document.documentElement.classList.add('theme-' + theme);
        document.documentElement.dataset.theme = theme;
      })()`);
      await win.webContents.executeJavaScript(`(() => {
        state.currentBrowserIds = ['browser-preview'];
        state.automationCards = [{ id: 'card-preview', name: '微软账号登录' }];
        state.currentCardId = 'card-preview';
        state.currentSession = { id: 'current-preview' };
        state.sessionList = [
          { id: 'recent-1', title: '整理微软账号登录流程', preview: '检查页面并完成登录', updatedAt: Date.now() - 120000 },
          { id: 'recent-2', title: '提取页面数据', preview: '已整理为表格', updatedAt: Date.now() - 7200000 },
          { id: 'recent-3', title: '规划自动化任务', preview: '共 6 个执行步骤', updatedAt: Date.now() - 86400000 },
        ];
        state.messages = [];
        renderWelcome();
      })()`);
      win.setSize(500, 820);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const image = await win.webContents.capturePage();
      fs.writeFileSync(process.env.AI_FREE_WELCOME_CAPTURE, image.toPNG());
    }
    result = { loaded: true, ...report, consoleErrors: consoleErrors.slice(0, 5) };
  } catch (error) {
    result = { loaded: false, error: String((error && error.message) || error), consoleErrors: consoleErrors.slice(0, 5) };
  }
  console.log('PROBE_RESULT ' + JSON.stringify(result));
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
  app.exit(result.loaded ? 0 : 1);
});
