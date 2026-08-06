'use strict';

const { net } = require('electron');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { toBoolean } = require('../../ipc/register/store-utils');
const { getClashMiniProfileRoots } = require('./clash-mini-assets');

const DEFAULT_LATENCY_PROBE_URL = 'https://www.gstatic.com/generate_204';

function normalizeProbeTimeout(value, fallbackMs = 2000) {
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) return Math.max(200, Math.round(num));
  return fallbackMs;
}

function normalizeProbeUrl(value, fallbackUrl = DEFAULT_LATENCY_PROBE_URL) {
  const text = String(value || '').trim() || String(fallbackUrl || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return String(fallbackUrl || '').trim();
    // HTTP 204 can be answered before a node has completed its TLS upstream.
    if (url.protocol === 'http:') return DEFAULT_LATENCY_PROBE_URL;
    return url.toString();
  } catch (_) {
    return String(fallbackUrl || '').trim();
  }
}

function findCurrentProfile(rootDir, profilesIndex) {
  const currentUid = String(profilesIndex.current || '').trim();
  const items = Array.isArray(profilesIndex.items) ? profilesIndex.items : [];
  const currentItem = items.find((item) => String(item?.uid || '').trim() === currentUid)
    || items.find((item) => String(item?.file || '').trim().replace(/\.ya?ml$/i, '') === currentUid)
    || null;
  const candidates = [];
  if (currentItem?.file) {
    candidates.push(path.join(rootDir, 'profiles', currentItem.file), path.join(rootDir, currentItem.file));
  }
  if (currentUid) {
    candidates.push(path.join(rootDir, 'profiles', `${currentUid}.yaml`), path.join(rootDir, `${currentUid}.yaml`));
  }
  return { currentUid, currentItem, profilePath: candidates.find((candidate) => fs.existsSync(candidate)) || '' };
}

function readProfileProbeSettings(rootDir) {
  const profilesIndexPath = path.join(rootDir, 'profiles.yaml');
  if (!fs.existsSync(profilesIndexPath)) return null;
  const profilesIndex = YAML.parse(fs.readFileSync(profilesIndexPath, 'utf8')) || {};
  const { currentUid, currentItem, profilePath } = findCurrentProfile(rootDir, profilesIndex);
  if (!profilePath) return null;
  const profile = YAML.parse(fs.readFileSync(profilePath, 'utf8')) || {};
  return {
    rootDir,
    profilesIndexPath,
    profilePath,
    profile,
    profileName: String(currentItem?.name || currentUid || '').trim(),
    profileUid: currentUid,
    latencyTimeoutMs: normalizeProbeTimeout(profile['cfw-latency-timeout'], 2000),
    latencyUrl: normalizeProbeUrl(profile['cfw-latency-url'], DEFAULT_LATENCY_PROBE_URL),
    connBreakStrategy: toBoolean(profile['cfw-conn-break-strategy'], false),
  };
}

function readClashProbeSettings() {
  for (const rootDir of getClashMiniProfileRoots()) {
    try {
      const settings = readProfileProbeSettings(rootDir);
      if (settings) return settings;
    } catch (error) {
      console.warn('[IPC] 读取 Clash Mini profile 配置失败:', error?.message || error);
    }
  }
  return null;
}

function normalizeProbeResult(result, startedAt) {
  return {
    ok: Boolean(result?.ok),
    statusCode: Number.isFinite(Number(result?.statusCode)) ? Number(result.statusCode) : null,
    elapsedMs: Number.isFinite(Number(result?.elapsedMs))
      ? Math.max(0, Math.round(Number(result.elapsedMs)))
      : Math.max(0, Date.now() - startedAt),
    error: result?.error ? String(result.error) : '',
  };
}

function attachProbeResponse(response, finish, startedAt) {
  const statusCode = response?.statusCode;
  response.on('error', (error) => finish({
    ok: false, error: error?.message || String(error), elapsedMs: Date.now() - startedAt, statusCode,
  }));
  response.on('aborted', () => finish({
    ok: false, error: '响应已中止', elapsedMs: Date.now() - startedAt, statusCode,
  }));
  response.on('end', () => finish({
    ok: typeof statusCode === 'number' && statusCode >= 200 && statusCode < 400,
    elapsedMs: Date.now() - startedAt,
    statusCode,
  }));
  try { response.resume?.(); } catch (_) {}
}

function probeLatencyUrl(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const safeUrl = normalizeProbeUrl(url, '');
    if (!safeUrl) {
      resolve({ ok: false, error: 'latency url missing', elapsedMs: 0, statusCode: null });
      return;
    }
    const startedAt = Date.now();
    let request = null;
    let timeoutHandle = null;
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      try { request?.abort?.(); } catch (_) {}
      resolve(normalizeProbeResult(result, startedAt));
    };
    try {
      request = net.request({
        method: 'GET',
        url: safeUrl,
        headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache', 'User-Agent': 'AI-FREE/ClashLatencyProbe' },
      });
      timeoutHandle = setTimeout(() => finish({
        ok: false,
        error: `请求超时（${timeoutMs}ms）`,
        elapsedMs: Date.now() - startedAt,
        statusCode: null,
      }), timeoutMs);
      request.on('response', (response) => attachProbeResponse(response, finish, startedAt));
      request.on('error', (error) => finish({
        ok: false, error: error?.message || String(error), elapsedMs: Date.now() - startedAt, statusCode: null,
      }));
      request.end();
    } catch (error) {
      finish({
        ok: false, error: error?.message || String(error), elapsedMs: Date.now() - startedAt, statusCode: null,
      });
    }
  });
}

module.exports = {
  DEFAULT_LATENCY_PROBE_URL,
  normalizeProbeTimeout,
  normalizeProbeUrl,
  readClashProbeSettings,
  probeLatencyUrl,
};
