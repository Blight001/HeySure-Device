'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('node:events');
const {
  createAppShellWindowStateController,
} = require('../../../src/app/main/services/app-shell-window-state');

function createFixture(t, storedState) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-window-state-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const statePath = path.join(userDataDir, 'app-window-state.json');
  if (storedState !== undefined) fs.writeFileSync(statePath, JSON.stringify(storedState), 'utf8');
  const controller = createAppShellWindowStateController({
    app: { getPath: () => userDataDir },
    fs,
    path,
    screen: {
      getDisplayMatching: () => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1040 },
      }),
    },
    logger: { warn() {} },
  });
  return { controller, statePath };
}

test('首次启动使用大窗口并默认最大化', (t) => {
  const { controller } = createFixture(t);
  assert.deepEqual(controller.getWindowOptions(), { width: 1440, height: 900 });
  assert.equal(controller.shouldMaximize(), true);
});

test('恢复上次普通窗口样式并把越界位置校正到当前屏幕', (t) => {
  const { controller } = createFixture(t, {
    version: 1,
    maximized: false,
    bounds: { x: 2200, y: -400, width: 1100, height: 760 },
  });
  assert.deepEqual(controller.getWindowOptions(), {
    x: 820,
    y: 0,
    width: 1100,
    height: 760,
  });
  assert.equal(controller.shouldMaximize(), false);
});

test('窗口尺寸和最大化样式在关闭前原子保存并可再次读取', (t) => {
  const { controller, statePath } = createFixture(t);
  const window = new EventEmitter();
  let maximized = true;
  let bounds = { x: 120, y: 80, width: 1320, height: 820 };
  window.isDestroyed = () => false;
  window.isMinimized = () => false;
  window.isMaximized = () => maximized;
  window.getBounds = () => bounds;
  window.getNormalBounds = window.getBounds;
  controller.bindWindow(window);
  window.emit('close');
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), {
    version: 1,
    maximized: true,
    bounds: { x: 120, y: 80, width: 1320, height: 820 },
  });
  maximized = false;
  bounds = { x: 40, y: 30, width: 1180, height: 740 };
  window.emit('close');
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), {
    version: 1,
    maximized: false,
    bounds: { x: 40, y: 30, width: 1180, height: 740 },
  });
  assert.equal(fs.readdirSync(path.dirname(statePath)).some((name) => name.endsWith('.tmp')), false);
});
