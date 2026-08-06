const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { ChromiumRuntime } = require('../../src/app/main/browser-runtime/chromium-runtime');
const { ChromiumWindowBridge } = require('../../src/app/main/browser-runtime/chromium-window-bridge');
const { RUNTIME_STATUS } = require('../../src/app/main/browser-runtime/runtime-types');

test('refocusing the app keeps Chromium above delayed Electron renderer reordering', async () => {
  const parentWindow = new EventEmitter();
  const calls = [];
  const runtime = new ChromiumRuntime({
    store: {
      getState: () => ({
        status: RUNTIME_STATUS.READY,
        hostHwnd: 'host-1',
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      }),
    },
    windowBridge: {
      setHostBounds: () => calls.push('bounds'),
      raiseHostWindow: () => calls.push('raise'),
      showHostWindow: () => calls.push('show'),
    },
    logger: { warn() {} },
  });
  const instance = {
    parentWindow,
    parentFocusHandler: null,
    parentFocusRaiseTimers: new Set(),
  };

  runtime.bindParentWindowFocus('profile-1', instance);
  parentWindow.emit('focus');
  assert.deepEqual(calls, ['raise']);
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.deepEqual(calls, ['raise', 'raise', 'raise']);
  runtime.unbindParentWindowFocus(instance);
  assert.equal(instance.parentFocusRaiseTimers.size, 0);
});

test('an already loaded legacy native host skips focus repaint safely', () => {
  const bridge = new ChromiumWindowBridge({ binding: {} });
  assert.equal(bridge.raiseHostWindow('host-1'), true);
  assert.equal(bridge.releaseChildWindowFocus('child-1'), true);
});

test('releasing Chromium focus delegates the active browser HWND to the native bridge', () => {
  const calls = [];
  const runtime = new ChromiumRuntime({
    store: { getState: () => ({ browserHwnd: 'child-1' }) },
    windowBridge: {
      releaseChildWindowFocus: (hwnd) => {
        calls.push(hwnd);
        return true;
      },
    },
  });

  assert.equal(runtime.releaseFocus('profile-1'), true);
  assert.deepEqual(calls, ['child-1']);
});
