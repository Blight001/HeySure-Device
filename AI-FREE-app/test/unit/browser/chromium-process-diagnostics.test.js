'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createChromiumLaunchDiagnostics,
  createChromiumProcessFailure,
  formatWindowsExitCode,
} = require('../../../src/app/main/browser-runtime/chromium-process-diagnostics');

test('Windows 有符号退出码同时显示十六进制 NTSTATUS', () => {
  assert.equal(formatWindowsExitCode(-1073741515), '-1073741515 / 0xC0000135');
});

test('Chromium 诊断仅保留最近的有限输出并附加到失败消息', () => {
  const diagnostics = createChromiumLaunchDiagnostics();
  for (let index = 0; index < 25; index += 1) diagnostics.record('stderr', `line-${index}`);

  const error = createChromiumProcessFailure(diagnostics, { exitCode: 1 });

  assert.equal(error.code, 'CHROMIUM_PROCESS_EXITED');
  assert.ok(!error.message.includes('line-0'));
  assert.ok(error.message.includes('line-24'));
});

test('Chromium 退出码 3 说明其含义不唯一并给出独立日志位置', () => {
  const diagnostics = createChromiumLaunchDiagnostics({
    logFilePath: 'C:\\Users\\tester\\AppData\\Roaming\\AI-FREE\\logs\\chromium-runtime.log',
  });

  const error = createChromiumProcessFailure(diagnostics, { exitCode: 3 });

  assert.match(error.message, /多种定义/);
  assert.match(error.message, /不能仅凭此码判断根因/);
  assert.match(error.message, /Code Integrity\/AppLocker/);
  assert.match(error.message, /chromium-runtime\.log/);
  assert.equal(error.logFilePath, diagnostics.logFilePath);
});

test('Chromium 进程失败时附加自动生成的脱敏诊断包路径', () => {
  const diagnostics = createChromiumLaunchDiagnostics();
  diagnostics.createBundle = () => 'C:\\AI-FREE\\diagnostics\\chromium-failure.json';

  const error = createChromiumProcessFailure(diagnostics, { exitCode: 3 });

  assert.match(error.message, /脱敏诊断包/);
  assert.equal(error.diagnosticBundlePath, 'C:\\AI-FREE\\diagnostics\\chromium-failure.json');
});
