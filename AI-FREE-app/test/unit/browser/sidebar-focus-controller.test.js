const test = require('node:test');
const assert = require('node:assert/strict');
const { createSidebarFocusHandler } = require('../../../src/app/main/features/browser/sidebar-focus-controller');

function createHarness() {
  const calls = [];
  const shellContents = { focus: () => calls.push('shell-focus'), isDestroyed: () => false };
  const sideContents = {
    focus: () => calls.push('sidebar-focus'),
    isDestroyed: () => false,
    isFocused: () => true,
  };
  const mainWindow = {
    webContents: shellContents,
    isDestroyed: () => false,
    isMinimized: () => false,
    isFocused: () => true,
  };
  const ui = {
    browserRuntimeManager: {
      releaseFocus: (profileId, type) => calls.push(`release:${profileId}:${type}`),
    },
    getActiveTabId: () => 'active-profile',
    getMainWindow: () => mainWindow,
    getSideView: () => ({ webContents: sideContents }),
  };
  return { calls, sideContents, ui };
}

test('sidebar text input releases native browser focus before focusing Electron contents', async () => {
  const { calls, ui } = createHarness();
  const handler = createSidebarFocusHandler(ui);

  const result = await handler({ sender: {} }, { interaction: 'text-input' });

  assert.deepEqual(calls, ['release:active-profile:chromium', 'shell-focus', 'sidebar-focus']);
  assert.deepEqual(result, { ok: true, stableTextInput: true });
});

test('passive focus follows the regular sidebar focus path', async () => {
  const { calls, ui } = createHarness();
  const handler = createSidebarFocusHandler(ui);

  const result = await handler({ sender: {} }, { interaction: 'passive' });

  assert.deepEqual(calls, [
    'release:active-profile:chromium',
    'shell-focus', 'sidebar-focus',
    'shell-focus', 'sidebar-focus',
    'shell-focus', 'sidebar-focus',
  ]);
  assert.deepEqual(result, { ok: true, sideFocused: true });
});
