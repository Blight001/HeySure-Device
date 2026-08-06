'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const REPORT_SCHEMA_VERSION = 1;
const UPLOAD_PATH = '/api/crash-reports';
const MAX_NATIVE_DUMP_BYTES = 64 * 1024 * 1024;
const MAX_COMPRESSED_UPLOAD_BYTES = 31 * 1024 * 1024;
const MAX_KEPT_SESSION_FILES = 40;

function safeString(value, fallback = '') {
  try {
    if (value instanceof Error) return value.stack || value.message || String(value);
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return fallback;
    return util.format(value);
  } catch (_) {
    return fallback;
  }
}

function isoNow() {
  return new Date().toISOString();
}

function makeId() {
  try { return crypto.randomUUID(); } catch (_) {
    return `${Date.now()}-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  }
}

function writeJsonAtomicSync(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  let published = false;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
    published = true;
  } finally {
    if (!published) {
      try { fs.unlinkSync(tempPath); } catch (_) {}
    }
  }
}

function readJsonSafe(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return null; }
}

function redactText(value) {
  let text = safeString(value);
  /** @type {Array<[RegExp, string]>} */
  const replacements = [
    [/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;"']+/ig, '$1[REDACTED]'],
    [/(cookie\s*[:=]\s*)[^\r\n]+/ig, '$1[REDACTED]'],
    [/(set-cookie\s*[:=]\s*)[^\r\n]+/ig, '$1[REDACTED]'],
    [/(\b(?:password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|admin[_-]?token|activation[_-]?code)\b\s*["']?\s*[:=]\s*["']?)[^\s,"'};]+/ig, '$1[REDACTED]'],
    [/(\btoken=)[^&\s]+/ig, '$1[REDACTED]'],
  ];
  for (const [pattern, replacement] of replacements) text = text.replace(pattern, replacement);
  return text;
}

function normalizeDetails(details) {
  if (!details || typeof details !== 'object') return {};
  const result = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined || typeof value === 'function') continue;
    if (/password|cookie|secret|token|authorization|activation.?code/i.test(key)) result[key] = '[REDACTED]';
    else if (value instanceof Error) result[key] = redactText(value.stack || value.message);
    else if (typeof value === 'object' && value !== null) result[key] = normalizeObject(value);
    else result[key] = typeof value === 'string' ? redactText(value) : value;
  }
  return result;
}

function normalizeObject(value) {
  try { return JSON.parse(redactText(JSON.stringify(value))); } catch (_) { return redactText(value); }
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') || '';
}

function safeAppValue(app, method, fallback = '') {
  try {
    const value = app && typeof app[method] === 'function' ? app[method]() : '';
    return value ? String(value) : fallback;
  } catch (_) {
    return fallback;
  }
}

function resolveUserDataDir(app) {
  try {
    const value = app && typeof app.getPath === 'function' ? app.getPath('userData') : '';
    if (value) return value;
  } catch (_) {}
  const appName = safeAppValue(app, 'getName', process.env.ELECTRON_APP_NAME || 'ai-free');
  if (process.platform === 'win32' && process.env.APPDATA) return path.join(process.env.APPDATA, appName);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', appName);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), appName);
}

function isProcessAlive(pid) {
  const processId = Number(pid);
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

module.exports = {
  MAX_COMPRESSED_UPLOAD_BYTES,
  MAX_KEPT_SESSION_FILES,
  MAX_NATIVE_DUMP_BYTES,
  REPORT_SCHEMA_VERSION,
  UPLOAD_PATH,
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
};
