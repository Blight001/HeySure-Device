'use strict';

const {
  BROWSER_CAPACITY_DEFAULTS,
  calculateBrowserCapacity,
} = require('./browser-capacity-policy');

const BROWSER_LAUNCH_CODES = Object.freeze({
  allowed: 'BROWSER_LAUNCH_ALLOWED',
  allowedWithWarning: 'BROWSER_LAUNCH_ALLOWED_WITH_WARNING',
  snapshotUnavailable: 'BROWSER_RESOURCE_SNAPSHOT_UNAVAILABLE',
  snapshotPartial: 'BROWSER_RESOURCE_SNAPSHOT_PARTIAL',
  memoryCritical: 'BROWSER_RESOURCE_MEMORY_CRITICAL',
  memoryWarningCapacity: 'BROWSER_RESOURCE_MEMORY_WARNING_CAPACITY',
  diskCritical: 'BROWSER_RESOURCE_DISK_CRITICAL',
  capacityReached: 'BROWSER_DEVICE_CAPACITY_REACHED',
});

function publicSnapshot(snapshot, capacity) {
  return Object.freeze({
    status: snapshot.status,
    pressure: snapshot.pressure,
    totalMemoryMb: snapshot.totalMemoryMb,
    availableMemoryMb: snapshot.availableMemoryMb,
    freeDiskMb: snapshot.freeDiskMb,
    logicalCores: snapshot.logicalCores,
    activeProfiles: capacity.activeProfiles,
    profileLimit: capacity.profileLimit,
  });
}

function decision(ok, code, retryable, snapshot, capacity, warningCode = null) {
  return Object.freeze({
    ok,
    code,
    retryable,
    warningCode,
    snapshot: publicSnapshot(snapshot, capacity),
    capacity,
  });
}

function evaluateBrowserLaunch(snapshot, options = {}) {
  const capacity = calculateBrowserCapacity(snapshot, options);
  const codes = BROWSER_LAUNCH_CODES;
  if (!snapshot || snapshot.status === 'unavailable') {
    return decision(false, codes.snapshotUnavailable, true, snapshot || {}, capacity);
  }
  if (snapshot.availableMemoryMb === null || snapshot.freeDiskMb === null) {
    return decision(false, codes.snapshotPartial, true, snapshot, capacity);
  }
  if (snapshot.freeDiskMb < BROWSER_CAPACITY_DEFAULTS.diskCriticalMb) {
    return decision(false, codes.diskCritical, true, snapshot, capacity);
  }
  if (snapshot.pressure === 'critical') {
    return decision(false, codes.memoryCritical, true, snapshot, capacity);
  }
  if (snapshot.pressure === 'warning' && capacity.activeProfiles > 0) {
    return decision(false, codes.memoryWarningCapacity, true, snapshot, capacity);
  }
  if (capacity.atCapacity) {
    return decision(false, codes.capacityReached, false, snapshot, capacity);
  }
  if (snapshot.pressure === 'warning' || snapshot.status === 'partial') {
    return decision(true, codes.allowedWithWarning, false, snapshot, capacity, snapshot.pressure === 'warning'
      ? codes.memoryWarningCapacity
      : codes.snapshotPartial);
  }
  return decision(true, codes.allowed, false, snapshot, capacity);
}

function createBrowserLaunchGuard(options = {}) {
  if (!options.resourceMonitor || typeof options.resourceMonitor.getSnapshot !== 'function') {
    throw new TypeError('resourceMonitor.getSnapshot is required');
  }
  const capacityPolicy = options.capacityPolicy || evaluateBrowserLaunch;
  return Object.freeze({
    async evaluate(context = {}) {
      const snapshot = await options.resourceMonitor.getSnapshot({ force: true, maxAgeMs: 2_000 });
      return capacityPolicy(snapshot, context);
    },
  });
}

module.exports = {
  BROWSER_LAUNCH_CODES,
  createBrowserLaunchGuard,
  evaluateBrowserLaunch,
};
