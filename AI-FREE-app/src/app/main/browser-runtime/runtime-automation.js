'use strict';

const { findProfileIdByProcessId } = require('./runtime-input');

const AUTOMATION_COMMANDS = new Set([
  'observe-page', 'capture-screenshot', 'perform-action', 'get-session-data',
]);
const ACTIONS = new Set([
  'click', 'double_click', 'right_click', 'upload_file', 'scroll', 'type', 'press_key', 'wait',
]);

function automationError(code, message) {
  const error = /** @type {Error & {code?: string}} */ (new Error(message));
  error.code = code;
  return error;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function optionalText(value, maxLength = 8192) {
  if (value === undefined || value === null) return '';
  const result = String(value);
  if (result.length > maxLength) {
    throw automationError('AUTOMATION_PAYLOAD_INVALID', `文本参数超过 ${maxLength} 字符限制`);
  }
  return result;
}

function normalizeObservePayload(source) {
  return {
    limit: boundedInteger(source.limit ?? source.max_items, 200, 1, 1000),
    keyword: optionalText(source.keyword, 512),
    tag: optionalText(source.tag, 64).toLowerCase(),
    filter: optionalText(source.filter, 64).toLowerCase(),
    includeText: source.include_text !== false,
    includeMedia: source.include_media !== false,
    showHighlights: source.mark !== false
      && source.show_highlights !== false
      && source.showHighlights !== false,
    highlightDurationMs: boundedInteger(
      source.highlight_duration_ms ?? source.highlightDurationMs,
      5000, 500, 30000,
    ),
  };
}

function normalizeScreenshotPayload(source) {
  const format = optionalText(source.format || 'png', 16).toLowerCase();
  if (format !== 'png') {
    throw automationError('SCREENSHOT_FORMAT_INVALID', '原生截图当前只支持 PNG');
  }
  return {
    format,
    x: boundedInteger(source.x, 0, 0, 1_000_000),
    y: boundedInteger(source.y, 0, 0, 1_000_000),
    width: boundedInteger(source.width, 0, 0, 1_000_000),
    height: boundedInteger(source.height, 0, 0, 1_000_000),
    selector: optionalText(source.selector, 4096),
    fullPage: source.full_page === true || source.fullPage === true,
  };
}

function normalizeActionPayload(source) {
  const action = optionalText(source.action, 32).trim();
  if (!ACTIONS.has(action)) {
    throw automationError('AUTOMATION_ACTION_INVALID', `不支持的原生页面动作: ${action || '<empty>'}`);
  }
  return {
    action,
    selector: optionalText(source.selector, 4096),
    text: optionalText(source.text ?? source.value, 1024 * 1024),
    key: optionalText(source.key, 64),
    ref: optionalText(source.ref, 128),
    direction: optionalText(source.direction || 'down', 16),
    amount: boundedInteger(source.amount ?? source.delta_y, 600, -100000, 100000),
    timeoutMs: boundedInteger(source.timeout_ms ?? source.timeout, 10000, 100, 120000),
  };
}

function normalizeRuntimeAutomation(command, source = {}) {
  const name = String(command || '').trim();
  if (!AUTOMATION_COMMANDS.has(name)) {
    throw automationError('AUTOMATION_COMMAND_INVALID', `不支持的 Chromium 自动化命令: ${name || '<empty>'}`);
  }
  const input = asObject(source);
  if (name === 'observe-page') return normalizeObservePayload(input);
  if (name === 'capture-screenshot') return normalizeScreenshotPayload(input);
  if (name === 'perform-action') return normalizeActionPayload(input);
  return {};
}

async function dispatchRuntimeAutomation(runtime, profileId, command, source) {
  const payload = normalizeRuntimeAutomation(command, source);
  return runtime.enqueueProfileOperation(profileId, () => (
    runtime.getReadyInstance(profileId).commandClient.send(command, payload, {
      timeoutMs: command === 'perform-action' ? payload.timeoutMs + 2000 : 15000,
    })
  ));
}

async function dispatchRuntimeAutomationByProcessId(runtime, processId, command, source) {
  const profileId = findProfileIdByProcessId(runtime.instances, processId);
  if (profileId) return dispatchRuntimeAutomation(runtime, profileId, command, source);
  throw automationError(
    'CHROMIUM_PROCESS_NOT_MANAGED',
    `Chromium 进程 ${Number(processId || 0) || '<empty>'} 不属于当前受管 Profile`,
  );
}

module.exports = {
  ACTIONS,
  AUTOMATION_COMMANDS,
  dispatchRuntimeAutomation,
  dispatchRuntimeAutomationByProcessId,
  normalizeRuntimeAutomation,
};
