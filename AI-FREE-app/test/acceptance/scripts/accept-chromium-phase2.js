'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { createBrowserRuntimeManager } = require('../../../src/app/main/browser-runtime');

delete process.env.AI_FREE_CHROMIUM_HANDSHAKE;
delete process.env.AI_FREE_CHROMIUM_PATH;

const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-phase2-'));
const switchCount = Math.max(1, Number(process.env.AI_FREE_ACCEPT_SWITCHES) || 500);
const soakMs = Math.max(0, Number(process.env.AI_FREE_ACCEPT_SOAK_MS) || 2 * 60 * 60 * 1000);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let window;
let manager;

function bounds(seed = 0) {
  const [width, height] = window.getContentSize();
  return { x: 0, y: 41, width: Math.max(640, width - (seed % 3)), height: Math.max(480, height - 41 - (seed % 2)) };
}

function assertReady(state, profileId, storedProfileId = profileId) {
  if (!state || state.profileId !== storedProfileId || state.status !== 'ready' ||
      state.bridgeConnected !== true || !state.sessionId || !state.browserHwnd ||
      state.embedded !== true) {
    throw new Error(`Profile ${profileId} runtime state invalid: ${JSON.stringify(state)}`);
  }
}

async function shutdown(code) {
  try { await manager?.stopAll({ timeoutMs: 5000 }); } catch (_) {}
  try { fs.rmSync(profileRoot, { recursive: true, force: true }); } catch (_) {}
  app.exit(code);
}

app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 1280, height: 850, show: true, title: 'AI-FREE Phase 2 Acceptance' });
  await window.loadURL('data:text/html,<body style="background:%23101827;color:white;font-family:sans-serif"><h2>AI-FREE Chromium Phase 2 acceptance running</h2></body>');
  manager = createBrowserRuntimeManager({
    userDataDir: profileRoot,
    resourcesPath: path.resolve(__dirname, '..', '..', '..', 'resources'),
    getParentWindow: () => window,
    logger: console,
  });

  // 覆盖真实账号场景：中文平台名不能直接交给 Fork 的 ASCII switch API。
  const profiles = ['phase2_a', '豆包::phase2_b'];
  for (const profileId of profiles) {
    const state = await manager.launchProfile({
      profileId,
      runtimeType: 'chromium',
      initialUrl: 'https://example.com',
      launchTimeoutMs: 30000,
    }, bounds());
    assertReady(state, profileId, manager.store.getProfilePaths(profileId).id);
    await manager.hide(profileId, 'chromium');
  }

  for (let index = 0; index < switchCount; index++) {
    const active = profiles[index % profiles.length];
    const inactive = profiles[(index + 1) % profiles.length];
    await manager.hide(inactive, 'chromium');
    await manager.resize(active, 'chromium', bounds(index));
    await manager.show(active, 'chromium');
    await manager.focus(active, 'chromium');
    const state = manager.getState(active);
    if (!state || !state.browserHwnd || state.embedded !== true || state.status !== 'ready') {
      throw new Error(`Switch ${index + 1} failed for ${active}: ${JSON.stringify(state)}`);
    }
    await delay(10);
  }
  console.log(`[phase2-acceptance] ${switchCount} switches passed`);

  const soakStarted = Date.now();
  while (Date.now() - soakStarted < soakMs) {
    for (const profileId of profiles) {
      const state = manager.getState(profileId);
      if (!state || !state.browserHwnd || state.embedded !== true ||
          !state.sessionId || Date.now() - state.lastHeartbeatAt > 12000) {
        throw new Error(`Soak health failed for ${profileId}: ${JSON.stringify(state)}`);
      }
    }
    await delay(3000);
  }
  console.log(`[phase2-acceptance] ${soakMs} ms soak passed`);
  await shutdown(0);
}).catch(async (error) => {
  console.error('[phase2-acceptance] FAILED', error.stack || error);
  await shutdown(1);
});

app.on('window-all-closed', () => { void shutdown(0); });
