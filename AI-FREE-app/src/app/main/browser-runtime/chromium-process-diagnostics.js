'use strict';

const MAX_DIAGNOSTIC_LINES = 20;
const MAX_DIAGNOSTIC_LINE_LENGTH = 500;

const WINDOWS_EXIT_HINTS = new Map([
  [3, 'Chromium 对退出码 3 有多种定义，可能来自无效 IPC 或沙箱组件，不能仅凭此码判断根因；若不带 AI-FREE 私有参数的最小启动也失败，请检查 Windows Code Integrity/AppLocker 事件、安全软件注入和系统兼容性。'],
  [0xC0000135, '系统缺少 Chromium 依赖的 DLL，请检查安装包内核文件是否完整以及 VC++ 运行库。'],
  [0xC000007B, 'Chromium 或其 DLL 的 32/64 位架构不匹配，或依赖文件已损坏。'],
  [0xC0000005, 'Chromium 发生访问冲突，请检查安全软件拦截、驱动兼容性和损坏的内核文件。'],
  [0xC000001D, '当前 CPU 不支持该 Chromium 构建使用的指令集。'],
  [0xC0000409, 'Chromium 被系统快速终止，请检查安全软件拦截、运行库和内核文件完整性。'],
]);

function normalizeDiagnosticLine(source, value) {
  const line = String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  if (!line) return '';
  const shortened = line.length > MAX_DIAGNOSTIC_LINE_LENGTH
    ? `${line.slice(0, MAX_DIAGNOSTIC_LINE_LENGTH)}…`
    : line;
  return `[${source}] ${shortened}`;
}

function createChromiumLaunchDiagnostics(options = {}) {
  const lines = [];
  return {
    logFilePath: String(options.logFilePath || ''),
    record(source, value) {
      const line = normalizeDiagnosticLine(source, value);
      if (!line) return;
      lines.push(line);
      if (lines.length > MAX_DIAGNOSTIC_LINES) lines.shift();
      options.onRecord?.(source, value);
    },
    summarize() {
      return lines.join(' | ');
    },
  };
}

function formatWindowsExitCode(exitCode) {
  if (!Number.isInteger(exitCode)) return '';
  const unsigned = exitCode >>> 0;
  return `${exitCode} / 0x${unsigned.toString(16).toUpperCase().padStart(8, '0')}`;
}

function diagnosticLogPath(diagnostics) {
  return String(diagnostics && diagnostics.logFilePath || '');
}

function chromiumFailureSuffix(diagnostics, hint, summary, bundlePath) {
  return [
    hint,
    summary ? `内核输出: ${summary}` : '未捕获到 Chromium 内核输出',
    diagnosticLogPath(diagnostics) ? `完整启动日志: ${diagnosticLogPath(diagnostics)}` : '',
    bundlePath ? `脱敏诊断包: ${bundlePath}` : '',
  ].filter(Boolean).join(' ');
}

function persistProcessFailure(diagnostics, reason, hint) {
  if (diagnostics && typeof diagnostics.record === 'function') {
    diagnostics.record('process', `${reason}; ${hint || 'no-exit-hint'}`);
  }
}

function createFailureBundle(diagnostics, details, reason) {
  try {
    return diagnostics?.createBundle?.({
      reason,
      exitCode: Number.isInteger(details.exitCode) ? details.exitCode : null,
      signal: details.signal || null,
      spawnError: details.spawnError?.message || '',
    }) || '';
  } catch (_) {
    return '';
  }
}

function createChromiumProcessFailure(diagnostics, details = {}) {
  const spawnError = details.spawnError;
  const formattedCode = formatWindowsExitCode(details.exitCode);
  const hint = Number.isInteger(details.exitCode) ? WINDOWS_EXIT_HINTS.get(details.exitCode >>> 0) : '';
  const reason = spawnError
    ? `Chromium 进程启动失败: ${spawnError.message || spawnError}`
    : `Chromium 在完成窗口握手前退出${formattedCode ? `（退出码 ${formattedCode}）` : ''}`;
  persistProcessFailure(diagnostics, reason, hint);
  const diagnosticBundlePath = createFailureBundle(diagnostics, details, reason);
  const summary = diagnostics?.summarize?.() || '';
  const suffix = chromiumFailureSuffix(diagnostics, hint, summary, diagnosticBundlePath);
  const error = /** @type {Error & {code?: string, exitCode?: number|null, diagnostic?: string, logFilePath?: string, diagnosticBundlePath?: string}} */ (
    new Error(`${reason}。${suffix}`)
  );
  error.code = spawnError ? 'CHROMIUM_PROCESS_ERROR' : 'CHROMIUM_PROCESS_EXITED';
  error.exitCode = Number.isInteger(details.exitCode) ? details.exitCode : null;
  error.diagnostic = summary;
  error.logFilePath = diagnosticLogPath(diagnostics);
  error.diagnosticBundlePath = diagnosticBundlePath;
  return error;
}

function bindChromiumProcessFailure(instance, onFailure) {
  instance.child.once('error', (spawnError) => {
    instance.launchFailure = createChromiumProcessFailure(instance.diagnostics, { spawnError });
    onFailure(instance.launchFailure);
  });
  instance.child.once('exit', (exitCode, signal) => {
    if (instance.expectedExit) return;
    instance.launchFailure ||= createChromiumProcessFailure(instance.diagnostics, { exitCode, signal });
    onFailure(instance.launchFailure);
  });
}

module.exports = {
  bindChromiumProcessFailure,
  createChromiumLaunchDiagnostics,
  createChromiumProcessFailure,
  formatWindowsExitCode,
};
