'use strict';

// 主进程只负责同步落盘、Crashpad 和心跳。独立看门狗负责异常退出识别与上传，
// 因而主进程在任意 native crash 中立即消失也不会中断报告收集。
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { launchCrashWatchdog } = require('./crash-watchdog/launcher');
const { PendingReportStore } = require('./crash-watchdog/pending-store');
const {
  REPORT_SCHEMA_VERSION,
  firstValue,
  isProcessAlive,
  isoNow,
  makeId,
  normalizeDetails,
  readJsonSafe,
  redactText,
  resolveUserDataDir,
  safeAppValue,
  safeString,
  writeJsonAtomicSync,
} = require('./crash-watchdog/shared');

const HEARTBEAT_INTERVAL_MS = 15 * 1000;
let singleton = null;

class CrashReporterRuntime {
  /** @param {{app?: any, crashReporter?: any, ipcMain?: any, launchWatchdog?: Function, processAlive?: Function}} [deps] */
  constructor(deps = {}) {
    this.app = deps.app;
    this.crashReporter = deps.crashReporter;
    this.ipcMain = deps.ipcMain;
    this.launchWatchdog = deps.launchWatchdog || launchCrashWatchdog;
    this.processAlive = deps.processAlive || isProcessAlive;
    this.rootDir = path.join(resolveUserDataDir(this.app), 'crash-reports');
    this.pendingDir = path.join(this.rootDir, 'pending');
    this.sessionsDir = path.join(this.rootDir, 'sessions');
    this.dumpsDir = path.join(this.rootDir, 'dumps');
    this.store = new PendingReportStore(this.rootDir, { isProcessAlive: this.processAlive });
    this.installationId = this.resolveInstallationId();
    this.sessionId = makeId();
    this.startedAt = isoNow();
    this.sessionPath = path.join(this.sessionsDir, `${this.sessionId}.json`);
    this.currentLogPath = '';
    this.serverBase = '';
    this.startupPhase = 'early-main-load';
    this.heartbeatTimer = null;
    this.watchdogPid = 0;
    this.fatalCaptureInProgress = false;
    this.cleanExit = false;
    this.serverBaseResolver = null;
    this.capture = this.enqueue.bind(this);
    this.markCleanExit = this.markCleanExit.bind(this);
  }

  resolveInstallationId() {
    const filePath = path.join(this.rootDir, 'installation-id');
    let value = '';
    try { value = String(fs.readFileSync(filePath, 'utf8') || '').trim(); } catch (_) {}
    if (value) return value;
    value = makeId();
    try { fs.writeFileSync(filePath, value, { encoding: 'utf8', flag: 'wx' }); } catch (_) {}
    return value;
  }

  baseMetadata() {
    return {
      schemaVersion: REPORT_SCHEMA_VERSION,
      installationId: this.installationId,
      sessionId: this.sessionId,
      appName: safeAppValue(this.app, 'getName', 'AI-FREE'),
      appVersion: safeAppValue(this.app, 'getVersion', process.env.npm_package_version || ''),
      isPackaged: Boolean(this.app?.isPackaged),
      platform: process.platform,
      arch: process.arch,
      osType: os.type(),
      osRelease: os.release(),
      osVersion: typeof os.version === 'function' ? os.version() : '',
      hostnameHash: crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 16),
      processVersions: { ...process.versions },
      locale: Intl.DateTimeFormat().resolvedOptions().locale || '',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    };
  }

  buildSessionState(extra = {}) {
    const current = readJsonSafe(this.sessionPath) || {};
    return {
      ...current,
      sessionId: this.sessionId,
      installationId: this.installationId,
      appMetadata: this.baseMetadata(),
      startedAt: this.startedAt,
      lastSeenAt: isoNow(),
      cleanExit: this.cleanExit || current.cleanExit === true,
      reportedCrash: current.reportedCrash === true,
      fatalIncidentRecorded: current.fatalIncidentRecorded === true,
      startupPhase: this.startupPhase,
      pid: process.pid,
      logFilePath: this.currentLogPath,
      serverBase: this.serverBase,
      serverBaseConfigured: Boolean(this.serverBase),
      ...extra,
    };
  }

  writeSessionState(extra = {}) {
    try { writeJsonAtomicSync(this.sessionPath, this.buildSessionState(extra)); } catch (_) {}
  }

  markFatalIncident(reportId) {
    this.writeSessionState({
      reportedCrash: true,
      fatalIncidentRecorded: true,
      reportId,
      fatalIncidentAt: isoNow(),
    });
  }

  buildIncident(type, error, details, options, reportId) {
    const rawError = error instanceof Error ? error : null;
    return {
      ...this.baseMetadata(),
      reportId,
      type: String(type || 'unknown'),
      severity: options.fatal ? 'fatal' : firstValue(options.severity, 'error'),
      eventTime: isoNow(),
      startupPhase: this.startupPhase,
      pid: process.pid,
      processType: firstValue(options.processType, 'browser'),
      message: redactText(firstValue(rawError?.message, safeString(error, type))),
      stack: redactText(firstValue(rawError?.stack, details.stack)),
      details: normalizeDetails(details),
      logFiles: this.currentLogPath ? [this.currentLogPath] : [],
      sessionStatePath: this.sessionPath,
      dumpDirectory: this.dumpsDir,
    };
  }

  enqueue(type, error, details = {}, options = {}) {
    if (options.fatal && this.fatalCaptureInProgress) return '';
    if (options.fatal) this.fatalCaptureInProgress = true;
    const reportId = makeId();
    try {
      const incident = this.buildIncident(type, error, details, options, reportId);
      writeJsonAtomicSync(path.join(this.pendingDir, `${reportId}.json`), incident);
      if (options.marksMainExit === true) this.markFatalIncident(reportId);
      this.appendEmergencyLog(type, incident);
      return reportId;
    } catch (_) {
      return '';
    } finally {
      if (options.fatal) setImmediate(() => { this.fatalCaptureInProgress = false; });
    }
  }

  appendEmergencyLog(type, incident) {
    try {
      const summary = firstValue(incident.stack, incident.message);
      fs.appendFileSync(
        path.join(this.rootDir, 'crash-emergency.log'),
        `[${incident.eventTime}] ${type}: ${summary}\n`,
        'utf8',
      );
    } catch (_) {}
  }

  startNativeCrashReporter() {
    try {
      this.app?.setPath?.('crashDumps', this.dumpsDir);
      this.crashReporter?.start?.({
        companyName: 'AI-FREE',
        productName: 'AI-FREE',
        submitURL: 'http://127.0.0.1/',
        uploadToServer: false,
        compress: true,
        globalExtra: { installationId: this.installationId, sessionId: this.sessionId },
      });
    } catch (_) {}
  }

  ensureWatchdog() {
    if (this.cleanExit || this.processAlive(this.watchdogPid)) return this.watchdogPid;
    try {
      this.watchdogPid = this.launchWatchdog({
        app: this.app,
        rootDir: this.rootDir,
        sessionPath: this.sessionPath,
        parentPid: process.pid,
      });
      this.writeSessionState({ watchdogPid: this.watchdogPid, watchdogStartedAt: isoNow() });
    } catch (error) {
      try { console.warn('[崩溃上报] 独立看门狗启动失败，将在心跳时重试:', error?.message || error); } catch (_) {}
    }
    return this.watchdogPid;
  }

  attachRunLog(logFilePath) {
    this.currentLogPath = String(logFilePath || '');
    this.writeSessionState();
  }

  setStartupPhase(phase) {
    this.startupPhase = String(phase || 'unknown');
    this.writeSessionState();
  }

  setServerBaseResolver(resolver) {
    this.serverBaseResolver = typeof resolver === 'function' ? resolver : null;
    this.refreshServerBase();
  }

  refreshServerBase() {
    if (!this.serverBaseResolver) return this.serverBase;
    try {
      const value = String(this.serverBaseResolver() || '').trim().replace(/\/+$/, '');
      if (value && value !== this.serverBase) this.configure({ serverBase: value });
    } catch (_) {}
    return this.serverBase;
  }

  configure(options = {}) {
    this.serverBase = String(options.serverBase || this.serverBase || '').trim().replace(/\/+$/, '');
    this.writeSessionState();
    return Promise.resolve({ uploaded: 0, pending: true, delegated: true, watchdogPid: this.watchdogPid });
  }

  markCleanExit() {
    this.cleanExit = true;
    this.writeSessionState({ cleanExit: true, endedAt: isoNow() });
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  installProcessHandlers() {
    process.on('uncaughtExceptionMonitor', (error, origin) => {
      this.enqueue('uncaught-exception', error, { origin }, {
        fatal: true,
        marksMainExit: true,
        processType: 'browser',
      });
    });
    process.on('unhandledRejection', (reason) => {
      this.enqueue('unhandled-rejection', reason, {}, { severity: 'error', processType: 'browser' });
    });
  }

  installAppHandlers() {
    this.app?.on?.('before-quit', this.markCleanExit);
    this.app?.on?.('render-process-gone', (_event, contents, details) => this.captureRendererGone(contents, details));
    this.app?.on?.('child-process-gone', (_event, details) => this.captureChildGone(details));
    this.app?.on?.('web-contents-created', (_event, contents) => this.watchWebContents(contents));
  }

  captureRendererGone(contents, details = {}) {
    this.enqueue('render-process-gone', details.reason || 'renderer process exited', {
      ...details,
      url: contents?.getURL?.() || '',
      webContentsId: contents?.id,
    }, { fatal: ['crashed', 'oom'].includes(details.reason), processType: 'renderer' });
  }

  captureChildGone(details = {}) {
    const type = details.type || 'child';
    const reason = details.reason || 'unknown';
    this.enqueue('child-process-gone', `${type} process exited: ${reason}`, details, {
      fatal: ['crashed', 'oom'].includes(reason),
      processType: type,
    });
  }

  watchWebContents(contents) {
    contents.on?.('unresponsive', () => this.enqueue('renderer-unresponsive', '渲染进程无响应', {
      url: contents.getURL?.() || '', webContentsId: contents.id,
    }, { severity: 'error', processType: 'renderer' }));
    contents.on?.('preload-error', (_event, preloadPath, error) => this.enqueue('preload-error', error, {
      preloadPath, url: contents.getURL?.() || '', webContentsId: contents.id,
    }, { severity: 'error', processType: 'renderer' }));
  }

  installIpcHandler() {
    this.ipcMain?.on?.('__ai_free_renderer_error__', (event, payload = {}) => {
      this.enqueue('renderer-javascript-error', payload.message || 'renderer JavaScript error', {
        stack: payload.stack || '',
        source: payload.source || '',
        line: payload.line || 0,
        column: payload.column || 0,
        url: event.sender?.getURL?.() || '',
        webContentsId: event.sender?.id,
      }, { severity: 'error', processType: 'renderer' });
    });
  }

  startTimers() {
    this.heartbeatTimer = setInterval(() => {
      this.refreshServerBase();
      this.writeSessionState();
      this.ensureWatchdog();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  initialize() {
    this.store.recoverOrphanSessions(this.sessionId);
    this.writeSessionState();
    this.startNativeCrashReporter();
    this.ensureWatchdog();
    this.installProcessHandlers();
    this.installAppHandlers();
    this.installIpcHandler();
    this.startTimers();
    return this;
  }
}

function installEarlyCrashReporter(dependencies = {}) {
  if (singleton) return singleton;
  singleton = new CrashReporterRuntime(dependencies).initialize();
  return singleton;
}

function getCrashReporter() {
  return singleton;
}

module.exports = {
  CrashReporterRuntime,
  getCrashReporter,
  installEarlyCrashReporter,
  redactText,
};
