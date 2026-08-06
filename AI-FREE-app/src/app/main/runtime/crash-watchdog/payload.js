'use strict';

const fs = require('fs');
const path = require('path');

const {
  MAX_NATIVE_DUMP_BYTES,
  normalizeDetails,
  redactText,
  safeString,
} = require('./shared');

const DUMP_TIME_WINDOW_MS = 30 * 60 * 1000;
const MAX_DUMP_SCAN_DEPTH = 3;
const MAX_DUMP_CANDIDATES = 100;

function readLog(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { name: path.basename(filePath), size: Buffer.byteLength(content), content: redactText(content) };
  } catch (error) {
    return { name: path.basename(filePath || 'run.log'), error: safeString(error?.message || error) };
  }
}

function collectLogs(rootDir, incident) {
  const paths = Array.isArray(incident.logFiles) ? incident.logFiles : [];
  const logs = paths.map((filePath) => readLog(filePath));
  const emergencyPath = path.join(rootDir, 'crash-emergency.log');
  try { if (fs.existsSync(emergencyPath)) logs.push(readLog(emergencyPath)); } catch (_) {}
  return logs;
}

function listDumpFiles(rootDir) {
  const files = [];
  const stack = [{ dir: rootDir, depth: 0 }];
  while (stack.length && files.length < MAX_DUMP_CANDIDATES) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current.dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      const filePath = path.join(current.dir, entry.name);
      if (entry.isDirectory() && current.depth < MAX_DUMP_SCAN_DEPTH) {
        stack.push({ dir: filePath, depth: current.depth + 1 });
      } else if (entry.isFile() && /\.(dmp|zip)$/i.test(entry.name)) {
        files.push(filePath);
      }
      if (files.length >= MAX_DUMP_CANDIDATES) break;
    }
  }
  return files;
}

function describeDump(filePath, eventMs) {
  try {
    const stat = fs.statSync(filePath);
    return { filePath, name: path.basename(filePath), stat, distance: Math.abs(stat.mtimeMs - eventMs) };
  } catch (_) {
    return null;
  }
}

function serializeDump(dump) {
  if (!dump) return null;
  if (dump.stat.size > MAX_NATIVE_DUMP_BYTES) {
    return { name: dump.name, size: dump.stat.size, omitted: 'native dump exceeds client read limit' };
  }
  return {
    name: dump.name,
    size: dump.stat.size,
    encoding: 'base64',
    content: fs.readFileSync(dump.filePath).toString('base64'),
  };
}

function collectNativeDump(rootDir, incident) {
  try {
    const eventMs = Date.parse(incident.eventTime || '') || Date.now();
    const candidates = listDumpFiles(incident.dumpDirectory || path.join(rootDir, 'dumps'))
      .map((filePath) => describeDump(filePath, eventMs))
      .filter((item) => item && item.distance <= DUMP_TIME_WINDOW_MS)
      .sort((a, b) => a.distance - b.distance);
    return serializeDump(candidates[0]);
  } catch (_) {
    return null;
  }
}

function buildUploadPayload(rootDir, incident) {
  return {
    ...incident,
    message: redactText(incident.message),
    stack: redactText(incident.stack),
    details: normalizeDetails(incident.details),
    logs: collectLogs(rootDir, incident),
    nativeDump: collectNativeDump(rootDir, incident),
  };
}

module.exports = { buildUploadPayload, collectNativeDump };
