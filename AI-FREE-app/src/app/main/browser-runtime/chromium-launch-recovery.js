'use strict';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;
const LOW_SPEC_HANDSHAKE_TIMEOUT_MS = 60_000;
const MAX_TOTAL_LAUNCH_BUDGET_MS = 90_000;

const FAILURE_CATEGORY = Object.freeze({
  CANCELLED: 'cancelled',
  EXECUTABLE_MISSING: 'executable-missing',
  GPU: 'gpu',
  HANDSHAKE_TIMEOUT: 'handshake-timeout',
  HOST_ATTACHMENT: 'host-attachment',
  RESOURCE: 'resource',
  SAFETY: 'safety',
  UNKNOWN: 'unknown',
});

/** @type {Set<string>} */
const NO_RETRY_CATEGORIES = new Set([
  FAILURE_CATEGORY.CANCELLED,
  FAILURE_CATEGORY.EXECUTABLE_MISSING,
  FAILURE_CATEGORY.RESOURCE,
  FAILURE_CATEGORY.SAFETY,
  FAILURE_CATEGORY.UNKNOWN,
]);

function normalizedCode(error) {
  return String(error?.code || '').trim().toUpperCase();
}

function normalizedDiagnosticText(error, diagnostics) {
  const values = [
    error?.diagnosticCode,
    diagnostics?.code,
    diagnostics?.category,
    diagnostics?.processType,
    diagnostics?.reason,
  ];
  return values.filter(Boolean).join(' ').toLowerCase().slice(0, 512);
}

function isGpuFailure(error, diagnostics) {
  const code = normalizedCode(error);
  if (['CHROMIUM_GPU_INIT_FAILED', 'CHROMIUM_GPU_PROCESS_CRASHED'].includes(code)) return true;
  const text = normalizedDiagnosticText(error, diagnostics);
  return /\bgpu(?:[_ -](?:init|initialization|process))?(?:[_ -](?:failed|crash(?:ed)?))\b/.test(text);
}

function classifyChromiumLaunchFailure(error, diagnostics = {}) {
  const code = normalizedCode(error);
  if (code === 'CHROMIUM_LAUNCH_CANCELLED' || diagnostics.cancelled === true) {
    return FAILURE_CATEGORY.CANCELLED;
  }
  if (/^(?:BROWSER_)?RESOURCE_/.test(code) || /^BROWSER_RESOURCE_/.test(code)) {
    return FAILURE_CATEGORY.RESOURCE;
  }
  if (code === 'CHROMIUM_EXECUTABLE_NOT_FOUND' || code === 'ENOENT') {
    return FAILURE_CATEGORY.EXECUTABLE_MISSING;
  }
  if (/PREFLIGHT|INTEGRITY|HASH|SANDBOX|ACL|NON_NTFS|FORBIDDEN|UNSAFE/.test(code)) {
    return FAILURE_CATEGORY.SAFETY;
  }
  if (isGpuFailure(error, diagnostics)) return FAILURE_CATEGORY.GPU;
  if (['CHROMIUM_WINDOW_TIMEOUT', 'CHROMIUM_HANDSHAKE_TIMEOUT'].includes(code)) {
    return FAILURE_CATEGORY.HANDSHAKE_TIMEOUT;
  }
  if (['CHROMIUM_HWND_ATTACH_FAILED', 'CHROMIUM_HOST_WINDOW_FAILED'].includes(code)) {
    return FAILURE_CATEGORY.HOST_ATTACHMENT;
  }
  return FAILURE_CATEGORY.UNKNOWN;
}

function getChromiumHandshakeBudget(options = {}) {
  const extended = options.lowSpecMode === true || options.coldStart === true;
  const requested = Number(options.requestedTimeoutMs);
  const base = extended ? LOW_SPEC_HANDSHAKE_TIMEOUT_MS : DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requested) && requested > 0 ? requested : base;
  const elapsedMs = Math.max(0, Number(options.elapsedLaunchMs) || 0);
  const remainingMs = Math.max(0, MAX_TOTAL_LAUNCH_BUDGET_MS - elapsedMs);
  return Math.max(0, Math.min(timeoutMs, remainingMs));
}

function noRetry(category, code, retryCount) {
  return Object.freeze({ retry: false, category, code, retryCount });
}

function buildRetry(category, retryCount, handshakeTimeoutMs) {
  let mode = 'rebuild-host';
  /** @type {Record<string, any>} */
  let launchOverrides = { rebuildHostWindow: true };
  if (category === FAILURE_CATEGORY.GPU) {
    mode = 'gpu-safe';
    launchOverrides = { additionalArgs: Object.freeze(['--disable-gpu']) };
  } else if (category === FAILURE_CATEGORY.HANDSHAKE_TIMEOUT) {
    mode = 'extended-handshake';
    launchOverrides = { launchTimeoutMs: handshakeTimeoutMs };
  }
  return Object.freeze({
    retry: true,
    category,
    code: `CHROMIUM_RETRY_${category.replaceAll('-', '_').toUpperCase()}`,
    retryCount,
    mode,
    cleanupRequired: true,
    requireProcessTreeExit: true,
    requireProfileLockReleased: true,
    requireHostWindowDestroyed: true,
    launchOverrides: Object.freeze(launchOverrides),
  });
}

function createChromiumLaunchRecovery(options = {}) {
  const maxRetries = Number(options.maxRetries) === 0 ? 0 : 1;
  let retryCount = 0;
  return Object.freeze({
    get retryCount() { return retryCount; },
    decide(error, context = {}) {
      const category = classifyChromiumLaunchFailure(error, context.diagnostics);
      if (context.cancelled === true || category === FAILURE_CATEGORY.CANCELLED) {
        return noRetry(FAILURE_CATEGORY.CANCELLED, 'CHROMIUM_RETRY_CANCELLED', retryCount);
      }
      if (retryCount >= maxRetries) return noRetry(category, 'CHROMIUM_RETRY_LIMIT_REACHED', retryCount);
      if (NO_RETRY_CATEGORIES.has(category)) return noRetry(category, 'CHROMIUM_RETRY_NOT_ALLOWED', retryCount);
      if (category === FAILURE_CATEGORY.HANDSHAKE_TIMEOUT) {
        const eligible = context.processAlive === true
          && (context.lowSpecMode === true || context.coldStart === true);
        if (!eligible) return noRetry(category, 'CHROMIUM_RETRY_NOT_ALLOWED', retryCount);
        const remainingMs = MAX_TOTAL_LAUNCH_BUDGET_MS - Math.max(0, Number(context.elapsedLaunchMs) || 0);
        if (remainingMs < 3_000) {
          return noRetry(category, 'CHROMIUM_TOTAL_LAUNCH_BUDGET_EXHAUSTED', retryCount);
        }
      }
      retryCount += 1;
      return buildRetry(category, retryCount, getChromiumHandshakeBudget({
        lowSpecMode: context.lowSpecMode,
        coldStart: context.coldStart,
        elapsedLaunchMs: context.elapsedLaunchMs,
        requestedTimeoutMs: context.retryHandshakeTimeoutMs,
      }));
    },
  });
}

module.exports = {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  FAILURE_CATEGORY,
  LOW_SPEC_HANDSHAKE_TIMEOUT_MS,
  MAX_TOTAL_LAUNCH_BUDGET_MS,
  classifyChromiumLaunchFailure,
  createChromiumLaunchRecovery,
  getChromiumHandshakeBudget,
};
