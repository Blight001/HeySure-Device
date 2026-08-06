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
      themeAfterToggle: (() => {
        // 真实触发主题应用逻辑（等价 app-theme-changed 广播路径）
        const root = document.documentElement;
        const before = root.dataset.theme;
        try { localStorage.setItem('ai-free.control-panel.theme', before === 'light' ? 'dark' : 'light'); } catch (_) {}
        return before;
      })(),
    })`);
    result = { loaded: true, ...report, consoleErrors: consoleErrors.slice(0, 5) };
  } catch (error) {
    result = { loaded: false, error: String((error && error.message) || error), consoleErrors: consoleErrors.slice(0, 5) };
  }
  console.log('PROBE_RESULT ' + JSON.stringify(result));
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
  app.exit(result.loaded ? 0 : 1);
});
