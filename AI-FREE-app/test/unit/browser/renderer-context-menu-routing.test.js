'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isRendererContextMenuPoint,
} = require('../../../src/app/main/utils/removeWatermark');

test('指定区域可由渲染层右键菜单独占，避免原生菜单抢焦点', async () => {
  let executed = '';
  const webContents = {
    isDestroyed: () => false,
    executeJavaScript: async (script) => {
      executed = script;
      return true;
    },
  };
  const owned = await isRendererContextMenuPoint(
    webContents,
    { x: 45.4, y: 91.7 },
    '.custom-renderer-menu',
  );
  assert.equal(owned, true);
  assert.match(executed, /elementFromPoint\(45, 92\)/);
  assert.match(executed, /custom-renderer-menu/);
});

test('普通区域继续使用现有原生右键菜单', async () => {
  const webContents = {
    isDestroyed: () => false,
    executeJavaScript: async () => false,
  };
  assert.equal(await isRendererContextMenuPoint(
    webContents,
    { x: 10, y: 20 },
    '.browser-history-item',
  ), false);
});
