'use strict';

const childProcess = require('child_process');
const path = require('path');
const { PendingReportStore } = require('./pending-store');
const { isProcessAlive, readJsonSafe } = require('./shared');
const { createCrashLoopGuard } = require('../crash-loop-guard');

const DEFAULT_POLL_MS = 1000;
const DEFAULT_RETRY_MS = 60 * 1000;
const DEFAULT_DUMP_SETTLE_MS = 3000;
const DEFAULT_POST_EXIT_MS = 30 * 60 * 1000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class CrashWatchdogWorker {
  constructor(options = {}) {
    this.rootDir = options.rootDir;
    this.sessionPath = options.sessionPath;
    this.parentPid = Number(options.parentPid) || 0;
    this.pollMs = Number(options.pollMs) || DEFAULT_POLL_MS;
    this.retryMs = Number(options.retryMs) || DEFAULT_RETRY_MS;
    this.dumpSettleMs = Number(options.dumpSettleMs) || DEFAULT_DUMP_SETTLE_MS;
    this.postExitMs = Number(options.postExitMs) || DEFAULT_POST_EXIT_MS;
    this.isProcessAlive = options.isProcessAlive || isProcessAlive;
    this.store = options.store || new PendingReportStore(this.rootDir, { isProcessAlive: this.isProcessAlive });
    this.onDiagnostic = options.onDiagnostic || (() => {});
    this.restartApplication = options.restartApplication || restartPackagedApplication;
    this.nextUploadAt = 0;
  }

  readSession() {
    return readJsonSafe(this.sessionPath) || {};
  }

  async uploadIfDue(state, force = false) {
    const serverBase = String(state.serverBase || '').trim();
    if (!serverBase || (!force && Date.now() < this.nextUploadAt)) return null;
    const result = await this.store.uploadPending(serverBase, this.onDiagnostic);
    this.nextUploadAt = Date.now() + this.retryMs;
    return result;
  }

  async monitorParent() {
    while (this.isProcessAlive(this.parentPid)) {
      await this.uploadIfDue(this.readSession());
      await delay(this.pollMs);
    }
  }

  async settleNativeDump() {
    const deadline = Date.now() + this.dumpSettleMs;
    while (Date.now() < deadline) await delay(Math.min(this.pollMs, deadline - Date.now()));
  }

  async finishAfterNormalExit(state) {
    await this.uploadIfDue(state, true);
    return { cleanExit: true, pending: this.store.pendingNames().length };
  }

  async finishAfterAbnormalExit(state) {
    await this.settleNativeDump();
    const reportId = this.store.recoverSession(this.sessionPath, { parentKnownDead: true });
    this.recoverApplicationIfAllowed(state);
    const deadline = Date.now() + this.postExitMs;
    let current = state;
    while (true) {
      current = this.readSession();
      const result = await this.uploadIfDue(current, true);
      const remaining = result?.remaining ?? this.store.pendingNames().length;
      if (remaining === 0 || !current.serverBase || Date.now() >= deadline) {
        return { cleanExit: false, reportId, pending: remaining };
      }
      await delay(Math.min(this.retryMs, Math.max(1, deadline - Date.now())));
    }
  }

  recoverApplicationIfAllowed(state) {
    if (state.isPackaged !== true) return null;
    const guard = createCrashLoopGuard({ filePath: path.join(this.rootDir, 'crash-loop.json') });
    const decision = guard.recordExit({ kind: 'crash' });
    if (!decision.autoRecover) {
      this.onDiagnostic(`崩溃循环保护: ${decision.action} (${decision.crashCount})`);
      return decision;
    }
    try {
      this.restartApplication(state.appExecutable);
      this.onDiagnostic('崩溃循环保护: 已执行一次受控恢复启动');
    } catch (error) {
      this.onDiagnostic(`恢复启动失败: ${error?.message || error}`);
    }
    return decision;
  }

  async run() {
    const currentSessionId = this.readSession().sessionId || '';
    this.store.recoverOrphanSessions(currentSessionId);
    await this.monitorParent();
    const state = this.readSession();
    if (state.cleanExit === true) return this.finishAfterNormalExit(state);
    return this.finishAfterAbnormalExit(state);
  }
}

function restartPackagedApplication(executablePath) {
  const rawTarget = String(executablePath || '').trim();
  if (!rawTarget) throw new Error('缺少应用可执行文件');
  const target = path.resolve(rawTarget);
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.AI_FREE_CRASH_WATCHDOG;
  const child = childProcess.spawn(target, [], {
    detached: true,
    env: environment,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref?.();
  return Number(child.pid) || 0;
}

module.exports = { CrashWatchdogWorker, restartPackagedApplication };
