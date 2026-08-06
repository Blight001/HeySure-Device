const SERVER_MODE_REMOTE = 'remote';
const SERVER_MODE_LOCAL = 'local';

function normalizeServerMode(value, fallback = SERVER_MODE_REMOTE) {
  const text = String(value || '').trim().toLowerCase();
  if (['local', 'debug', 'development', 'dev'].includes(text)) return SERVER_MODE_LOCAL;
  if (['remote', 'production', 'prod'].includes(text)) return SERVER_MODE_REMOTE;
  return fallback;
}

function getServerMode(env = process.env) {
  return normalizeServerMode(env?.AI_FREE_SERVER_MODE, SERVER_MODE_REMOTE);
}

function isLoopbackServerAddress(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`);
    const hostname = String(parsed.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    return hostname === 'localhost'
      || hostname === '::1'
      || /^127(?:\.|$)/.test(hostname);
  } catch (_) {
    return /^(?:https?:\/\/)?(?:localhost|127(?:\.|:)|\[?::1\]?)(?:[:/]|$)/i.test(raw);
  }
}

function inferServerMode(serverBase) {
  return isLoopbackServerAddress(serverBase) ? SERVER_MODE_LOCAL : SERVER_MODE_REMOTE;
}

function isServerBaseAllowedForMode(serverBase, mode = getServerMode()) {
  const value = String(serverBase || '').trim();
  if (!value) return false;
  return inferServerMode(value) === normalizeServerMode(mode);
}

module.exports = {
  SERVER_MODE_LOCAL,
  SERVER_MODE_REMOTE,
  getServerMode,
  inferServerMode,
  isLoopbackServerAddress,
  isServerBaseAllowedForMode,
  normalizeServerMode,
};
