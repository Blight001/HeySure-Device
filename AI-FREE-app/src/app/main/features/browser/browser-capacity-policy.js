'use strict';

const BROWSER_CAPACITY_DEFAULTS = Object.freeze({
  globalSafetyLimit: 8,
  productLimit: 5,
  administratorLimit: 8,
  diskCriticalMb: 2048,
});

function positiveLimit(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function deviceLimitForMemory(totalMemoryMb) {
  if (totalMemoryMb === null || totalMemoryMb === undefined || totalMemoryMb === '') return 1;
  const memory = Number(totalMemoryMb);
  if (!Number.isFinite(memory) || memory < 0) return 1;
  if (memory <= 4096) return 1;
  if (memory <= 8192) return 2;
  if (memory <= 16384) return 3;
  return 5;
}

function calculateBrowserCapacity(snapshot = {}, options = {}) {
  const productLimit = positiveLimit(options.productLimit, BROWSER_CAPACITY_DEFAULTS.productLimit);
  const deviceLimit = deviceLimitForMemory(snapshot.totalMemoryMb);
  const administratorLimit = positiveLimit(
    options.administratorLimit,
    BROWSER_CAPACITY_DEFAULTS.administratorLimit,
  );
  const globalSafetyLimit = positiveLimit(
    options.globalSafetyLimit,
    BROWSER_CAPACITY_DEFAULTS.globalSafetyLimit,
  );
  const profileLimit = Math.min(productLimit, deviceLimit, administratorLimit, globalSafetyLimit);
  const activeProfiles = positiveLimit(snapshot.activeProfiles, 0);
  return Object.freeze({
    productLimit,
    deviceLimit,
    administratorLimit,
    globalSafetyLimit,
    profileLimit,
    activeProfiles,
    remaining: Math.max(0, profileLimit - activeProfiles),
    atCapacity: activeProfiles >= profileLimit,
  });
}

module.exports = {
  BROWSER_CAPACITY_DEFAULTS,
  calculateBrowserCapacity,
  deviceLimitForMemory,
};
