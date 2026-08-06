const test = require('node:test');
const assert = require('node:assert/strict');

const { toggleSidebarVisibility } = require('../../src/app/main/services/tab-common');

test('reopening the sidebar restores its input target after layout', async () => {
  let sidebarVisible = false;
  let resizeCalls = 0;
  let ownerFocusCalls = 0;
  let shellFocusCalls = 0;
  let sidebarFocusCalls = 0;
  const mainWindow = {
    isDestroyed: () => false,
    isFocused: () => true,
    focus: () => { ownerFocusCalls += 1; },
    emit: (event) => { if (event === 'resize') resizeCalls += 1; },
    webContents: {
      isDestroyed: () => false,
      send() {},
      focus: () => { shellFocusCalls += 1; },
    },
  };
  const sideView = {
    webContents: {
      isDestroyed: () => false,
      send() {},
      focus: () => { sidebarFocusCalls += 1; },
    },
  };

  const result = toggleSidebarVisibility({
    getIsSidebarVisible: () => sidebarVisible,
    setIsSidebarVisible: (visible) => { sidebarVisible = visible; },
    getMainWindow: () => mainWindow,
    getSideView: () => sideView,
  });

  assert.equal(result, true);
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(resizeCalls, 1);
  assert.ok(ownerFocusCalls >= 1);
  assert.ok(shellFocusCalls >= 1);
  assert.ok(sidebarFocusCalls >= 2);
});
