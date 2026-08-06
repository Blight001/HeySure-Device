'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveSidebarWidth } = require('../../../src/app/shared/sidebar-layout');

test('普通窗口按内容宽度计算侧栏宽度', () => {
  assert.equal(resolveSidebarWidth({ contentWidth: 1200 }), 360);
});

test('最大化窗口保留侧栏当前像素宽度', () => {
  assert.equal(resolveSidebarWidth({
    contentWidth: 1920,
    isMaximized: true,
    currentWidth: 360,
    normalWindowWidth: 1200,
  }), 360);
});

test('首次以最大化状态启动时按普通窗口宽度恢复侧栏', () => {
  assert.equal(resolveSidebarWidth({
    contentWidth: 1920,
    isMaximized: true,
    normalWindowWidth: 1440,
  }), 432);
});

test('隐藏侧栏不占用内容宽度', () => {
  assert.equal(resolveSidebarWidth({
    contentWidth: 1920,
    isVisible: false,
    isMaximized: true,
    currentWidth: 360,
  }), 0);
});
