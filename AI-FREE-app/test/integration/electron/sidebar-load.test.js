// 集成测试（MISC-THEME-01 部分）：真实 Electron 加载侧边栏页面，
// 验证渲染结果与主题应用，不匹配任何实现源码。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..', '..', '..');

test('侧边栏页面在真实 Electron 中加载并应用主题', { timeout: 60000 }, () => {
  const out = execFileSync(process.execPath, [
    path.join(root, 'scripts', 'run-electron.js'),
    path.join(root, 'test', 'helpers', 'electron', 'sidebar-probe.js'),
  ], { cwd: root, encoding: 'utf8', timeout: 55000 });

  const line = out.split(/\r?\n/).find((l) => l.startsWith('PROBE_RESULT '));
  assert.ok(line, `探针未输出结果。输出片段: ${out.slice(-500)}`);
  const result = JSON.parse(line.slice('PROBE_RESULT '.length));

  assert.equal(result.loaded, true, `页面加载失败: ${result.error || ''}`);
  assert.ok(['dark', 'light', 'gold'].includes(result.theme), `主题未应用: ${result.theme}`);
  assert.equal(result.hasControlShell, true, '缺少 .control-shell 容器');
  assert.equal(result.tabButtons, 2, 'AI 控制/个人中心两个 tab 按钮应存在');
  assert.equal(result.chatStructure.userTag, 'ARTICLE', '用户气泡应是独立消息节点');
  assert.equal(result.chatStructure.assistantTag, 'ARTICLE', 'AI 回合应是独立消息节点');
  assert.equal(result.chatStructure.assistantCount, 1, '重启后模型工具协议消息不应重复渲染为 AI 气泡');
  assert.equal(result.chatStructure.activitySummary, '1次思考 · 1次工具调用');
  assert.equal(result.chatStructure.hasActivityRail, true, '思考与工具应位于活动时间线中');
  assert.match(result.chatStructure.toolSummary, /调用\s*AI-FREE\s*browser_observe\s*1\.2s/);
  assert.equal(result.chatStructure.toolName, 'browser_observe');
  assert.deepEqual(result.chatStructure.toolSections, ['参数', '结果']);
  assert.equal(result.chatStructure.activityCount, 2);
  assert.deepEqual(result.chatStructure.answerTexts, ['已经取得页面结构。', '页面操作已经完成。']);
  assert.deepEqual(result.chatStructure.turnOrder, ['activity', 'answer', 'activity', 'answer']);
  assert.deepEqual(result.consoleErrors, [], `页面控制台报错: ${JSON.stringify(result.consoleErrors)}`);
});
