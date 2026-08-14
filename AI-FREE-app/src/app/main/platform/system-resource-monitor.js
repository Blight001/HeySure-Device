'use strict';

const nodeFs = require('node:fs');
const nodeOs = require('node:os');

const MB = 1024 * 1024;
const RESOURCE_THRESHOLDS = Object.freeze({
  memoryCriticalMb: 768,
  memoryWarningMb: 1536,
  memoryCriticalRecoveryMb: 1024,
  memoryNormalRecoveryMb: 1792,
  criticalRecoveryMs: 15_000,
  normalRecoveryMs: 30_000,
});

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function toMb(bytes) {
  const value = finiteNumber(bytes);
  return value === null ? null : Math.round(value / MB);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function activeProfileCount(value) {
  if (Array.isArray(value)) return value.length;
  if (value instanceof Map || value instanceof Set) return value.size;
  return finiteNumber(value);
}

function readDiskFreeMb(fsApi, profileRoot) {
  if (!profileRoot || typeof fsApi.statfsSync !== 'function') return null;
  const stats = fsApi.statfsSync(profileRoot);
  return toMb(Number(stats.bavail) * Number(stats.bsize));
}

function pressureForMemory(availableMemoryMb, thresholds) {
  if (availableMemoryMb === null) return 'warning';
  if (availableMemoryMb < thresholds.memoryCriticalMb) return 'critical';
  if (availableMemoryMb < thresholds.memoryWarningMb) return 'warning';
  return 'normal';
}

function nextPressure(state, availableMemoryMb, now, thresholds) {
  const sampled = pressureForMemory(availableMemoryMb, thresholds);
  if (sampled === 'critical') return { pressure: 'critical', recoverySince: null };
  if (state.pressure === 'critical') {
    if (availableMemoryMb < thresholds.memoryCriticalRecoveryMb) return { ...state, recoverySince: null };
    const recoverySince = state.recoverySince ?? now;
    if (now - recoverySince < thresholds.criticalRecoveryMs) return { pressure: 'critical', recoverySince };
    return { pressure: 'warning', recoverySince: sampled === 'normal' ? now : null };
  }
  if (sampled === 'warning') return { pressure: 'warning', recoverySince: null };
  if (state.pressure === 'warning') {
    if (availableMemoryMb < thresholds.memoryNormalRecoveryMb) return { ...state, recoverySince: null };
    const recoverySince = state.recoverySince ?? now;
    if (now - recoverySince < thresholds.normalRecoveryMs) return { pressure: 'warning', recoverySince };
  }
  return { pressure: 'normal', recoverySince: null };
}

function snapshotStatus(values, errors) {
  const known = values.filter((value) => value !== null).length;
  if (known === 0) return 'unavailable';
  return errors.length || known < values.length ? 'partial' : 'available';
}

function createPeriodicSampler(options, sample, intervalMs) {
  let timer = null;
  const sampleInBackground = () => {
    void sample().catch(() => {
      const logger = options.logger || console;
      if (logger && typeof logger.warn === 'function') {
        logger.warn('[SystemResourceMonitor] resource sample failed');
      }
    });
  };
  return {
    start() {
      if (timer) return;
      sampleInBackground();
      timer = (options.setInterval || setInterval)(sampleInBackground, intervalMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (!timer) return;
      (options.clearInterval || clearInterval)(timer);
      timer = null;
    },
  };
}

function createSystemResourceMonitor(options = {}) {
  const osApi = options.os || nodeOs;
  const fsApi = options.fs || nodeFs;
  const clock = options.now || Date.now;
  const thresholds = Object.freeze({ ...RESOURCE_THRESHOLDS, ...(options.thresholds || {}) });
  const intervalMs = finiteNumber(options.intervalMs) || 5_000;
  let lastSnapshot = null;
  let samplePromise = null;
  let pressureState = { pressure: 'normal', recoverySince: null };

  async function collectSnapshot() {
    const errors = [];
    const safely = async (name, reader) => {
      try { return await reader(); } catch (_error) { errors.push(name); return null; }
    };
    const capturedAt = clock();
    const totalMemoryMb = toMb(await safely('totalMemory', () => osApi.totalmem()));
    const availableMemoryMb = toMb(await safely('availableMemory', () => osApi.freemem()));
    const mainProcessWorkingSetMb = toMb(await safely(
      'mainProcessWorkingSet',
      () => (options.getMainProcessMemoryBytes || (() => process.memoryUsage().rss))(),
    ));
    const activeProfiles = activeProfileCount(await safely(
      'activeProfiles',
      () => (options.getActiveProfiles || (() => 0))(),
    ));
    const freeDiskMb = await safely('freeDisk', () => readDiskFreeMb(fsApi, options.profileRoot));
    const logicalCores = finiteNumber(await safely('logicalCores', () => osApi.cpus().length));
    const lowSpecMode = await safely('lowSpecMode', () => (options.getLowSpecMode || (() => 'auto'))());
    const onBatteryPower = await safely('batteryPower', () => (
      options.getOnBatteryPower ? options.getOnBatteryPower() : null
    ));
    pressureState = nextPressure(pressureState, availableMemoryMb, capturedAt, thresholds);
    const values = [totalMemoryMb, availableMemoryMb, mainProcessWorkingSetMb, activeProfiles, freeDiskMb, logicalCores];
    lastSnapshot = deepFreeze({
      status: snapshotStatus(values, errors),
      capturedAt,
      pressure: pressureState.pressure,
      totalMemoryMb,
      availableMemoryMb,
      mainProcessWorkingSetMb,
      activeProfiles,
      freeDiskMb,
      logicalCores,
      lowSpecMode: typeof lowSpecMode === 'string' ? lowSpecMode : null,
      onBatteryPower: typeof onBatteryPower === 'boolean' ? onBatteryPower : null,
      unavailableMetrics: Object.freeze([...new Set(errors)]),
    });
    return lastSnapshot;
  }

  async function sample() {
    if (samplePromise) return samplePromise;
    samplePromise = collectSnapshot();
    try {
      return await samplePromise;
    } finally {
      samplePromise = null;
    }
  }

  async function getSnapshot({ force = false, maxAgeMs = 2_000 } = {}) {
    const age = lastSnapshot ? clock() - lastSnapshot.capturedAt : Infinity;
    return force || age > maxAgeMs ? sample() : lastSnapshot;
  }

  const periodic = createPeriodicSampler(options, sample, intervalMs);

  return Object.freeze({ getSnapshot, sample, start: periodic.start, stop: periodic.stop });
}

module.exports = {
  RESOURCE_THRESHOLDS,
  createSystemResourceMonitor,
  deepFreeze,
};
