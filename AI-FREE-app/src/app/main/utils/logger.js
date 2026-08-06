const fs = require('fs');
const { appContext } = require('../runtime/app-context');
const os = require('os');
const path = require('path');
const util = require('util');

let activeRunLogger = null;
const shutdownExceptionGuardTargets = new WeakSet();

// Mihomo 在应用退出时会主动关闭现有代理连接。此时 Node 可能把连接重置
// 作为未处理 rejection 上报；它只在明确的退出阶段属于预期清理。
function isExpectedShutdownNetworkError(error) {
  if (!appContext.isShuttingDown()) return false;
  const code = String(error?.code || error?.cause?.code || '').trim().toUpperCase();
  const message = String(error?.message || error?.cause?.message || error || '');
  return code === 'ECONNRESET' || /\bECONNRESET\b/i.test(message);
}

// Electron 会为主进程未捕获异常显示原生 “A JavaScript error occurred” 对话框。
// 仅在退出流程明确开始后安装此保护器，并且只接住预期的连接重置；其他异常
// 继续抛出，保持原有的故障可见性。
function installShutdownUncaughtExceptionGuard({ processRef = process } = {}) {
  if (!processRef || typeof processRef.prependListener !== 'function') return false;
  if (shutdownExceptionGuardTargets.has(processRef)) return false;

  const handler = (error) => {
    if (isExpectedShutdownNetworkError(error)) return;
    throw error;
  };
  processRef.prependListener('uncaughtException', handler);
  shutdownExceptionGuardTargets.add(processRef);
  return true;
}

// 处理：safeGetAppPath的具体业务逻辑。
function safeGetAppPath(app, name) {
  try {
    if (app && typeof app.getPath === 'function') {
      const value = app.getPath(name);
      if (value) return value;
    }
  } catch (_) {}
  return '';
}

// 获取/读取/解析：resolveUserDataDir的具体业务逻辑。
function resolveUserDataDir(app) {
  const fromElectron = safeGetAppPath(app, 'userData');
  if (fromElectron) return fromElectron;

  const appName = String(
    (app && typeof app.getName === 'function' && app.getName())
    || process.env.ELECTRON_APP_NAME
    || process.env.npm_package_name
    || 'ai-free'
  ).trim() || 'ai-free';

  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA;
    if (roaming) return path.join(roaming, appName);
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appName);
  }

  const xdgConfig = process.env.XDG_CONFIG_HOME;
  if (xdgConfig) return path.join(xdgConfig, appName);

  return path.join(os.homedir(), '.config', appName);
}

// 格式化/规范化：formatRunStamp的具体业务逻辑。
function formatRunStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

// 创建/初始化：buildLogLine的具体业务逻辑。
function buildLogLine(level, args) {
  const timestamp = new Date().toISOString();
  const line = util.format(...args);
  return `[${timestamp}] [${level.toUpperCase()}] ${line}`;
}

// 设置/更新/持久化：writeConsoleSafely的具体业务逻辑。
function writeConsoleSafely(writer, text) {
  if (typeof writer !== 'function') return;
  try {
    writer(text);
  } catch (error) {
    const code = error && error.code;
    if (code !== 'EPIPE' && code !== 'ERR_STREAM_DESTROYED') {
      throw error;
    }
  }
}

// 处理：stripAnsi的具体业务逻辑。
function stripAnsi(text) {
  try {
    return String(text || '').replace(
      /\u001B\[[0-9;]*m/g,
      '',
    );
  } catch (_) {
    return String(text || '');
  }
}

function captureOriginalConsole() {
  const fallback = typeof console.log === 'function' ? console.log.bind(console) : () => {};
  return {
    log: fallback,
    info: typeof console.info === 'function' ? console.info.bind(console) : fallback,
    warn: typeof console.warn === 'function' ? console.warn.bind(console) : fallback,
    error: typeof console.error === 'function' ? console.error.bind(console) : fallback,
    debug: typeof console.debug === 'function' ? console.debug.bind(console) : fallback,
  };
}

function openRunLogStream(logDir, prefix, originalConsole) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const logFileName = `${prefix}-${formatRunStamp()}-${process.pid}.log`;
    const logFilePath = path.join(logDir, logFileName);
    const stream = fs.createWriteStream(logFilePath, { flags: 'a', encoding: 'utf8' });
    stream.on('error', () => {});
    stream.write('\ufeff');
    return { logFilePath, stream };
  } catch (error) {
    originalConsole.warn('[日志] 无法创建日志文件，将仅输出到控制台:', error?.message || error);
    return { logFilePath: '', stream: null };
  }
}

// 创建/初始化：createLogger的具体业务逻辑。
function createLogger({ getSideWebContents = () => null } = {}) {
// 处理：sendToSide的具体业务逻辑。
  function sendToSide(channel, ...args) {
    try {
      const wc = getSideWebContents && getSideWebContents();
      if (wc && !wc.isDestroyed()) wc.send(channel, ...args);
    } catch (_) {}
  }

// 创建/初始化：buildTextFromArgs的具体业务逻辑。
  function buildTextFromArgs(tag, args) {
    try {
      return `[${tag}] ` + args.map(a => {
        if (a == null) return '';
        if (typeof a === 'string') return a;
        if (typeof a === 'number' || typeof a === 'boolean') return String(a);
        if (a instanceof Error) return a.message;
        try { return JSON.stringify(a); } catch (_) { return String(a); }
      }).join(' ');
    } catch (_) {
      return `[${tag}]`;
    }
  }

// 处理：log的具体业务逻辑。
  function log(tag, ...args) {
    try {
      console.log(`[${tag}]`, ...args);
      const t = String(tag || '');
      if (t.startsWith('HeySure')) {
        buildTextFromArgs(tag, args);
      }
    } catch (_) {}
  }

  return { log, sendToSide };
}

// 创建/初始化：initializeRunFileLogger的具体业务逻辑。
/** @param {{app?: any, dirName?: string, prefix?: string}} [options] */
function initializeRunFileLogger({ app, dirName = 'logs', prefix = 'run' } = {}) {
  if (activeRunLogger) return activeRunLogger;
  const userDataDir = resolveUserDataDir(app);
  const logDir = path.join(userDataDir, dirName);
  const originalConsole = captureOriginalConsole();
  const { logFilePath, stream } = openRunLogStream(logDir, prefix, originalConsole);

  let closed = false;

  function write(level, args) {
    try {
      if (!stream) return;
      stream.write(`${stripAnsi(buildLogLine(level, args))}\n`);
    } catch (_) {}
  }

// 处理：emit的具体业务逻辑。
  function emit(level, args) {
    const line = util.format(...args);
    if (level === 'warn') {
      writeConsoleSafely(originalConsole.warn, line);
    } else if (level === 'error') {
      writeConsoleSafely(originalConsole.error, line);
    } else if (level === 'info') {
      writeConsoleSafely(originalConsole.info, line);
    } else {
      writeConsoleSafely(originalConsole.log, line);
    }
    write(level, args);
  }

// 同步/连接：patchConsole的具体业务逻辑。
  function patchConsole() {
    console.log = (...args) => emit('info', args);
    console.info = (...args) => emit('info', args);
    console.warn = (...args) => emit('warn', args);
    console.error = (...args) => emit('error', args);
    console.debug = (...args) => emit('debug', args);
  }

// 处理：restoreConsole的具体业务逻辑。
  function restoreConsole() {
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    console.debug = originalConsole.debug;
  }

// 停止/关闭/清理：close的具体业务逻辑。
  function close() {
    if (closed) return;
    closed = true;
    try {
      restoreConsole();
    } catch (_) {}
    try {
      stream.end();
    } catch (_) {}
  }

  patchConsole();

// 处理：uncaughtExceptionHandler的具体业务逻辑。
  const uncaughtExceptionHandler = (error) => {
    try {
      if (isExpectedShutdownNetworkError(error)) return;
      const value = error instanceof Error ? (error.stack || error.message || String(error)) : String(error);
      originalConsole.error(value);
      write('error', [value]);
    } catch (_) {}
  };

// 处理：unhandledRejectionHandler的具体业务逻辑。
  const unhandledRejectionHandler = (reason) => {
    try {
      if (isExpectedShutdownNetworkError(reason)) return;
      const value = reason instanceof Error ? (reason.stack || reason.message || String(reason)) : util.format(reason);
      originalConsole.error(value);
      write('error', [value]);
    } catch (_) {}
  };

  process.on('uncaughtExceptionMonitor', uncaughtExceptionHandler);
  process.on('unhandledRejection', unhandledRejectionHandler);
  process.once('exit', close);
  process.once('beforeExit', close);

  activeRunLogger = {
    logDir,
    logFilePath,
    close,
    writeLine: (level, ...args) => write(String(level || 'info'), args),
  };

  console.log('[日志] 本次运行日志文件:', logFilePath);
  return activeRunLogger;
}

module.exports = {
  createLogger,
  initializeRunFileLogger,
  installShutdownUncaughtExceptionGuard,
  isExpectedShutdownNetworkError,
};
