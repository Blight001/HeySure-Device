const util = require('util');

const APP_CONSOLE_COLORS = {
  reset: '\x1b[0m', cyan: '\x1b[36m', blue: '\x1b[34m', green: '\x1b[32m',
  yellow: '\x1b[33m', red: '\x1b[31m', magenta: '\x1b[35m',
};

function formatAppConsoleValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Error) return value.stack || value.message || String(value);
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function detectAppConsoleSource(args) {
  const match = args.map(formatAppConsoleValue).join(' ').trim().match(/^\[([^\]]+)\]/);
  return match ? String(match[1] || '').trim() : '其它';
}

function captureAppConsole() {
  const log = console.log.bind(console);
  return {
    log,
    info: typeof console.info === 'function' ? console.info.bind(console) : log,
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: typeof console.debug === 'function' ? console.debug.bind(console) : log,
  };
}

class AppConsoleBridge {
  constructor(options = {}) {
    this.historyLimit = options.historyLimit || 500;
    this.getSenders = options.getSenders || (() => []);
    this.getDebugSenders = options.getDebugSenders || (() => []);
    this.getSender = options.getSender || (() => null);
    this.history = [];
    this.debugHistory = [];
    this.hasColor = Boolean(process.stdout?.isTTY || process.stderr?.isTTY || process.env.FORCE_COLOR);
  }

  shouldSuppress(args) {
    return detectAppConsoleSource(args) === 'TCP';
  }

  buildEntry(level, args) {
    return {
      level,
      source: detectAppConsoleSource(args),
      text: args.map(formatAppConsoleValue).join(' '),
      timestamp: new Date().toISOString(),
    };
  }

  appendBounded(target, entry) {
    target.push(entry);
    if (target.length > this.historyLimit) target.splice(0, target.length - this.historyLimit);
  }

  deliver(entry, resolveSenders) {
    try {
      const senderValue = typeof resolveSenders === 'function' ? resolveSenders() : [];
      const senderList = Array.isArray(senderValue) ? senderValue : [senderValue];
      const uniqueSenders = [];
      for (const sender of senderList) {
        if (!sender || typeof sender.send !== 'function' || uniqueSenders.includes(sender)) continue;
        uniqueSenders.push(sender);
        sender.send('app-console-line', entry);
      }
    } catch (_) {}
  }

  push(level, args) {
    try {
      if (this.shouldSuppress(args)) return;
      const entry = this.buildEntry(level, args);
      this.appendBounded(this.history, entry);
      this.appendBounded(this.debugHistory, entry);
      this.deliver(entry, () => this.getSenders() || this.getSender());
    } catch (_) {}
  }

  pushDebugOnly(level, args) {
    try {
      const entry = this.buildEntry(level, Array.isArray(args) ? args : [args]);
      this.appendBounded(this.debugHistory, entry);
      this.deliver(entry, this.getDebugSenders);
      return entry;
    } catch (_) { return null; }
  }

  pickColor(level, args) {
    if (!this.hasColor) return null;
    if (level === 'error') return APP_CONSOLE_COLORS.red;
    if (level === 'warn') return APP_CONSOLE_COLORS.yellow;
    const tag = (util.format(...args).trim().match(/^\[([^\]]+)\]/) || [])[1] || '';
    return ({ 启动: APP_CONSOLE_COLORS.cyan, 配置: APP_CONSOLE_COLORS.blue, IPC: APP_CONSOLE_COLORS.magenta,
      bridge: APP_CONSOLE_COLORS.green, Shutdown: APP_CONSOLE_COLORS.yellow })[tag] || APP_CONSOLE_COLORS.cyan;
  }

  emit(level, args, originalConsole) {
    if (this.shouldSuppress(args)) return;
    const line = util.format(...args);
    const color = this.pickColor(level, args);
    const text = color ? `${color}${line}${APP_CONSOLE_COLORS.reset}` : line;
    try {
      const writer = level === 'error' ? originalConsole.error
        : level === 'warn' ? originalConsole.warn : level === 'info' ? originalConsole.info : originalConsole.log;
      writer(text);
    } catch (error) {
      if (!['EPIPE', 'ERR_STREAM_DESTROYED'].includes(error?.code)) throw error;
    }
  }

  installLevel(level, originalConsole) {
    return (...args) => {
      this.emit(level, args, originalConsole);
      this.push(level, args);
    };
  }

  install() {
    const originalConsole = captureAppConsole();
    console.log = this.installLevel('info', originalConsole);
    console.info = this.installLevel('info', originalConsole);
    console.warn = this.installLevel('warn', originalConsole);
    console.error = this.installLevel('error', originalConsole);
    console.debug = this.installLevel('info', originalConsole);
  }
}

function createAppConsoleBridge(options) {
  const bridge = new AppConsoleBridge(options);
  return {
    install: bridge.install.bind(bridge),
    pushDebugOnly: bridge.pushDebugOnly.bind(bridge),
    getHistory: () => bridge.history.slice(),
    getDebugHistory: () => bridge.debugHistory.slice(),
  };
}

module.exports = { createAppConsoleBridge };
