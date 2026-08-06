'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { createBrowserRuntimeManager } = require('../../../src/app/main/browser-runtime');

process.env.AI_FREE_CHROMIUM_HANDSHAKE = 'prototype';

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-chromium-smoke-'));
let mainWindow = null;
let manager = null;
let shuttingDown = false;

function currentBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return { x: 0, y: 0, width: 1100, height: 720 };
  const [width, height] = mainWindow.getContentSize();
  return { x: 0, y: 0, width, height };
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await manager?.stopAll({ timeoutMs: 3000 }); } catch (error) {
    console.warn('[embed-smoke] cleanup warning:', error?.message || error);
  }
  try { fs.rmSync(smokeRoot, { recursive: true, force: true }); } catch (_) {}
  app.exit(exitCode);
}

app.whenReady().then(async () => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    title: 'AI-FREE Chromium HWND Embed Smoke',
    backgroundColor: '#111827',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  await mainWindow.loadURL('data:text/html;charset=utf-8,<title>Chromium Embed Smoke</title><body style="margin:0;background:%23111827;color:white;font-family:sans-serif"><h2 style="padding:24px">正在启动外部 Chromium…</h2></body>');

  manager = createBrowserRuntimeManager({
    userDataDir: smokeRoot,
    resourcesPath: process.resourcesPath,
    getParentWindow: () => mainWindow,
    logger: console,
  });

  mainWindow.on('resize', () => {
    void manager.resize('embed-smoke', 'chromium', currentBounds()).catch(() => {});
  });
  mainWindow.on('closed', () => { void shutdown(0); });

  try {
    const state = await manager.launchProfile({
      profileId: 'embed-smoke',
      runtimeType: 'chromium',
      displayName: 'HWND Embed Smoke',
      initialUrl: process.env.AI_FREE_SMOKE_URL || 'https://example.com',
      executablePath: process.env.AI_FREE_CHROMIUM_PATH,
      allowPrototypeWindowDiscovery: true,
      launchTimeoutMs: 30000,
    }, currentBounds());
    if (state?.embedded !== true || state?.productName !== 'AI-FREE') {
      throw new Error('Chromium 已启动，但未确认嵌入 AI-FREE BrowserHost');
    }
    console.log('[embed-smoke] READY', JSON.stringify(state));
    if (process.env.AI_FREE_SMOKE_AUTO_CLOSE === '1') {
      setTimeout(() => { void shutdown(0); }, 5000);
    }
  } catch (error) {
    console.error('[embed-smoke] FAILED', error?.stack || error);
    setTimeout(() => { void shutdown(1); }, 500);
  }
}).catch((error) => {
  console.error('[embed-smoke] BOOT FAILED', error?.stack || error);
  void shutdown(1);
});

app.on('window-all-closed', () => { void shutdown(0); });
