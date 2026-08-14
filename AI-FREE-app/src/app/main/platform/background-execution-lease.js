'use strict';

const DEFAULT_LEASE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_LEASE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function normalizeTimeout(value, fallback) {
  const timeout = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw Object.assign(new TypeError('Background execution lease timeout must be a positive number'), {
      code: 'BACKGROUND_EXECUTION_LEASE_INVALID_TIMEOUT',
    });
  }
  return Math.min(Math.floor(timeout), MAX_LEASE_TIMEOUT_MS);
}

function createLeaseError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function createPowerBlockerController(blocker, logger) {
  let blockerId = null;
  function start() {
    if (blockerId !== null) return;
    if (!blocker || typeof blocker.start !== 'function') {
      throw createLeaseError('BACKGROUND_EXECUTION_BLOCKER_UNAVAILABLE', 'Power save blocker is unavailable');
    }
    try {
      const startedId = blocker.start('prevent-app-suspension');
      if (!Number.isInteger(startedId) || startedId < 0) throw new Error('Invalid power save blocker id');
      blockerId = startedId;
    } catch (error) {
      throw createLeaseError('BACKGROUND_EXECUTION_BLOCKER_START_FAILED', 'Unable to protect background execution', error);
    }
  }
  function stop() {
    const activeId = blockerId;
    blockerId = null;
    if (activeId === null || !blocker || typeof blocker.stop !== 'function') return;
    try {
      if (typeof blocker.isStarted !== 'function' || blocker.isStarted(activeId)) blocker.stop(activeId);
    } catch (_) {
      logger?.warn?.('[BackgroundExecutionLease] 释放后台运行保护失败', {
        code: 'BACKGROUND_EXECUTION_BLOCKER_STOP_FAILED',
      });
    }
  }
  return Object.freeze({ isActive: () => blockerId !== null, start, stop });
}

function buildSnapshot(leases, blockerController, disposed) {
  return Object.freeze({
    activeLeaseCount: leases.size,
    blockerActive: blockerController.isActive(),
    disposed,
  });
}

function createBackgroundExecutionLeaseManager(options = {}) {
  const blockerController = createPowerBlockerController(options.powerSaveBlocker, options.logger);
  const schedule = options.setTimeout || setTimeout;
  const cancelSchedule = options.clearTimeout || clearTimeout;
  const now = options.now || Date.now;
  const defaultTimeoutMs = normalizeTimeout(options.defaultTimeoutMs, DEFAULT_LEASE_TIMEOUT_MS);
  const leases = new Map();
  let nextLeaseId = 1;
  let disposed = false;

  function release(leaseId) {
    const record = leases.get(leaseId);
    if (!record) return false;
    leases.delete(leaseId);
    cancelSchedule(record.timer);
    if (leases.size === 0) blockerController.stop();
    return true;
  }

  function acquire(input = {}) {
    if (disposed) {
      throw createLeaseError('BACKGROUND_EXECUTION_LEASE_MANAGER_DISPOSED', 'Lease manager has been disposed');
    }
    const timeoutMs = normalizeTimeout(input.timeoutMs, defaultTimeoutMs);
    blockerController.start();
    const id = nextLeaseId++;
    const acquiredAt = now();
    const record = { timer: null };
    leases.set(id, record);
    try {
      record.timer = schedule(() => release(id), timeoutMs);
    } catch (error) {
      leases.delete(id);
      if (leases.size === 0) blockerController.stop();
      throw createLeaseError('BACKGROUND_EXECUTION_LEASE_TIMER_FAILED', 'Unable to schedule lease timeout', error);
    }
    record.timer?.unref?.();
    return Object.freeze({
      id,
      acquiredAt,
      expiresAt: acquiredAt + timeoutMs,
      release: () => release(id),
    });
  }

  function getSnapshot() {
    return buildSnapshot(leases, blockerController, disposed);
  }

  function dispose() {
    if (disposed) return false;
    disposed = true;
    for (const record of leases.values()) cancelSchedule(record.timer);
    leases.clear();
    blockerController.stop();
    return true;
  }

  return Object.freeze({ acquire, dispose, getSnapshot, release });
}

module.exports = {
  DEFAULT_LEASE_TIMEOUT_MS,
  MAX_LEASE_TIMEOUT_MS,
  createBackgroundExecutionLeaseManager,
};
