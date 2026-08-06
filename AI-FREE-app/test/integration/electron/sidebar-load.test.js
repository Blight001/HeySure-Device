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
  assert.deepEqual(result.consoleErrors, [], `页面控制台报错: ${JSON.stringify(result.consoleErrors)}`);
});
