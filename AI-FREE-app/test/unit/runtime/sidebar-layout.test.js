'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { clampSidebarWidth, resolveSidebarWidth } = require('../../../src/app/shared/sidebar-layout');

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

test('手动宽度优先于默认比例并为主内容保留空间', () => {
  assert.equal(resolveSidebarWidth({ contentWidth: 1200, preferredWidth: 560 }), 560);
  assert.equal(resolveSidebarWidth({ contentWidth: 900, preferredWidth: 900 }), 580);
});

test('手动宽度限制在侧栏允许范围内', () => {
  assert.equal(clampSidebarWidth(120, 1600), 280);
  assert.equal(clampSidebarWidth(900, 1600), 720);
  assert.equal(clampSidebarWidth(500, 700), 380);
});

test('创建浏览器时沿用侧栏当前实际宽度', () => {
  assert.equal(resolveSidebarWidth({
    contentWidth: 3000,
    currentWidth: 900,
    retainCurrentWidth: true,
  }), 900);
});
