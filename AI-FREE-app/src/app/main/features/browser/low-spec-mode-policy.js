'use strict';

const LOW_SPEC_MODES = Object.freeze({
  AUTO: 'auto',
  ON: 'on',
  OFF: 'off',
});

const LOW_SPEC_SETTING_DEFAULTS = Object.freeze({ mode: LOW_SPEC_MODES.AUTO });
const AUTO_MEMORY_LIMIT_MB = 8 * 1024;
const AUTO_LOGICAL_CORE_LIMIT = 4;

function normalizeLowSpecMode(value, fallback = LOW_SPEC_MODES.AUTO) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'on' || normalized === 'off') return normalized;
  return fallback === 'auto' || fallback === 'on' || fallback === 'off' ? fallback : LOW_SPEC_MODES.AUTO;
}

function normalizeLowSpecSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : { mode: value };
  return Object.freeze({ mode: normalizeLowSpecMode(source.mode) });
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function resolveAutoDecision(system = {}) {
  const totalMemoryMb = finitePositive(system.totalMemoryMb);
  const logicalCores = finitePositive(system.logicalCores);
  if (totalMemoryMb !== null && totalMemoryMb <= AUTO_MEMORY_LIMIT_MB) {
    return { enabled: true, reason: 'memory' };
  }
  if (logicalCores !== null && logicalCores <= AUTO_LOGICAL_CORE_LIMIT) {
    return { enabled: true, reason: 'cpu' };
  }
  if (system.pressure === 'warning' || system.pressure === 'critical') {
    return { enabled: true, reason: 'resource-pressure' };
  }
  if (totalMemoryMb === null || logicalCores === null) {
    return { enabled: true, reason: 'unknown-capacity' };
  }
  return { enabled: false, reason: 'sufficient-capacity' };
}

/** @param {{settings?: unknown, system?: {totalMemoryMb?: unknown, logicalCores?: unknown, pressure?: string}}} [input] */
function resolveLowSpecMode(input = {}) {
  const { settings, system } = input;
  const normalized = normalizeLowSpecSettings(settings || LOW_SPEC_SETTING_DEFAULTS);
  let decision;
  if (normalized.mode === LOW_SPEC_MODES.ON) decision = { enabled: true, reason: 'user-on' };
  else if (normalized.mode === LOW_SPEC_MODES.OFF) decision = { enabled: false, reason: 'user-off' };
  else decision = resolveAutoDecision(system);
  return Object.freeze({
    configuredMode: normalized.mode,
    enabled: decision.enabled,
    reason: decision.reason,
    electronBackgroundThrottling: true,
    chromiumDisableBackgroundingOccludedWindows: !decision.enabled,
  });
}

module.exports = {
  AUTO_LOGICAL_CORE_LIMIT,
  AUTO_MEMORY_LIMIT_MB,
  LOW_SPEC_MODES,
  LOW_SPEC_SETTING_DEFAULTS,
  normalizeLowSpecMode,
  normalizeLowSpecSettings,
  resolveLowSpecMode,
};
