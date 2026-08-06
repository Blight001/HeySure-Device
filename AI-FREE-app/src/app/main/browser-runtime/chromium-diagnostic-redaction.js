'use strict';

const os = require('os');

function escapePattern(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceKnownPath(value, target, replacement) {
  const normalized = String(target || '').trim();
  if (!normalized) return value;
  return value.replace(new RegExp(escapePattern(normalized), 'gi'), replacement);
}

function redactSensitiveText(value, options = {}) {
  let redacted = String(value || '')
    .replace(/(--hs-runtime-token=)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1<redacted>')
    .replace(/((?:authorization|proxy-authorization)\s*:\s*bearer\s+)\S+/gi, '$1<redacted>')
    .replace(/((?:cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, '$1<redacted>')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1<redacted>@')
    .replace(/((?:api[_-]?key|client[_-]?secret|password|token)\s*[=:]\s*)[^\s,;]+/gi, '$1<redacted>');
  redacted = replaceKnownPath(redacted, options.homeDir || os.homedir(), '<user-home>');
  redacted = replaceKnownPath(redacted, options.tempDir || os.tmpdir(), '<temp>');
  redacted = replaceKnownPath(redacted, options.userDataDir, '<user-data>');
  return redacted;
}

module.exports = { redactSensitiveText };
