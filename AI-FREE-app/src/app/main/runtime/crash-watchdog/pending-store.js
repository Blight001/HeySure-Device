'use strict';

const fs = require('fs');
const path = require('path');

const { buildUploadPayload } = require('./payload');
const {
  MAX_KEPT_SESSION_FILES,
  REPORT_SCHEMA_VERSION,
  firstValue,
  isProcessAlive,
  isoNow,
  makeId,
  readJsonSafe,
  writeJsonAtomicSync,
} = require('./shared');
const { uploadPayload } = require('./transport');

const RECOVERY_CLAIM_STALE_MS = 5 * 60 * 1000;

class PendingReportStore {
  constructor(rootDir, options = {}) {
    this.rootDir = rootDir;
    this.pendingDir = path.join(rootDir, 'pending');
    this.sessionsDir = path.join(rootDir, 'sessions');
    this.dumpsDir = path.join(rootDir, 'dumps');
    this.isProcessAlive = options.isProcessAlive || isProcessAlive;
    this.uploadPayload = options.uploadPayload || uploadPayload;
    this.ensureDirectories();
  }

  ensureDirectories() {
    for (const dir of [this.rootDir, this.pendingDir, this.sessionsDir, this.dumpsDir]) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    }
  }

  buildAbnormalIncident(sessionPath, state) {
    const metadata = state.appMetadata && typeof state.appMetadata === 'object' ? state.appMetadata : {};
    return {
      schemaVersion: REPORT_SCHEMA_VERSION,
      ...metadata,
      reportId: makeId(),
      installationId: firstValue(state.installationId, metadata.installationId),
      sessionId: firstValue(state.sessionId, metadata.sessionId),
      type: 'abnormal-exit',
      severity: 'fatal',
      eventTime: firstValue(state.lastSeenAt, state.startedAt, isoNow()),
      detectedAt: isoNow(),
      startupPhase: firstValue(state.startupPhase, 'unknown'),
      pid: state.pid || null,
      processType: 'browser',
      message: '软件进程意外退出，独立看门狗已接管崩溃报告',
      stack: '',
      details: {
        recoverySource: 'independent-watchdog',
        previousStartedAt: firstValue(state.startedAt),
        watchdogPid: process.pid,
      },
      logFiles: state.logFilePath ? [state.logFilePath] : [],
      sessionStatePath: sessionPath,
      dumpDirectory: this.dumpsDir,
    };
  }

  isAlreadyHandled(state) {
    return state?.cleanExit === true
      || state?.fatalIncidentRecorded === true
      || state?.reportedCrash === true;
  }

  removeStaleClaim(claimPath) {
    const claim = readJsonSafe(claimPath);
    let age = 0;
    try { age = Date.now() - fs.statSync(claimPath).mtimeMs; } catch (_) { return; }
    if (this.isProcessAlive(claim?.pid) || age < RECOVERY_CLAIM_STALE_MS) return;
    try { fs.unlinkSync(claimPath); } catch (_) {}
  }

  claimRecovery(sessionPath) {
    const claimPath = `${sessionPath}.recovery`;
    this.removeStaleClaim(claimPath);
    try {
      fs.writeFileSync(claimPath, JSON.stringify({ pid: process.pid, claimedAt: isoNow() }), { flag: 'wx' });
      return () => { try { fs.unlinkSync(claimPath); } catch (_) {} };
    } catch (_) {
      return null;
    }
  }

  recoverSession(sessionPath, options = {}) {
    const initial = readJsonSafe(sessionPath);
    if (!initial || this.isAlreadyHandled(initial)) return '';
    if (!options.parentKnownDead && this.isProcessAlive(initial.pid)) return '';
    const release = this.claimRecovery(sessionPath);
    if (!release) return '';
    try {
      const state = readJsonSafe(sessionPath);
      if (!state || this.isAlreadyHandled(state)) return '';
      if (!options.parentKnownDead && this.isProcessAlive(state.pid)) return '';
      const incident = this.buildAbnormalIncident(sessionPath, state);
      writeJsonAtomicSync(path.join(this.pendingDir, `${incident.reportId}.json`), incident);
      writeJsonAtomicSync(sessionPath, {
        ...state,
        reportedCrash: true,
        fatalIncidentRecorded: true,
        reportId: incident.reportId,
        detectedAt: incident.detectedAt,
      });
      return incident.reportId;
    } finally {
      release();
    }
  }

  recoverOrphanSessions(currentSessionId = '') {
    let names = [];
    try { names = fs.readdirSync(this.sessionsDir).filter((name) => name.endsWith('.json')); } catch (_) {}
    let recovered = 0;
    for (const name of names) {
      if (path.basename(name, '.json') === currentSessionId) continue;
      const sessionPath = path.join(this.sessionsDir, name);
      if (this.recoverSession(sessionPath)) recovered += 1;
    }
    return recovered;
  }

  pendingNames() {
    try { return fs.readdirSync(this.pendingDir).filter((name) => name.endsWith('.json')).sort(); } catch (_) { return []; }
  }

  async uploadPending(serverBase, onDiagnostic = (_message) => {}) {
    let uploaded = 0;
    let failed = 0;
    for (const name of this.pendingNames()) {
      const filePath = path.join(this.pendingDir, name);
      const incident = readJsonSafe(filePath);
      if (!incident?.reportId) continue;
      try {
        await this.uploadPayload(serverBase, buildUploadPayload(this.rootDir, incident));
        try { fs.unlinkSync(filePath); } catch (_) {}
        uploaded += 1;
      } catch (error) {
        failed += 1;
        onDiagnostic(`上传 ${incident.reportId} 失败: ${error?.message || error}`);
      }
    }
    this.cleanupOldSessions();
    return { uploaded, failed, remaining: this.pendingNames().length };
  }

  cleanupOldSessions() {
    try {
      const files = fs.readdirSync(this.sessionsDir).filter((name) => name.endsWith('.json'))
        .map((name) => ({ name, mtime: fs.statSync(path.join(this.sessionsDir, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const item of files.slice(MAX_KEPT_SESSION_FILES)) fs.unlinkSync(path.join(this.sessionsDir, item.name));
    } catch (_) {}
  }
}

module.exports = { PendingReportStore };
