function buildLicenseRuntimeConfigPatch(runtimeConfig = {}, options = {}) {
  const nextRuntimeConfig = {};
  if (String(runtimeConfig.platformName || '').trim()) {
    nextRuntimeConfig.platformName = runtimeConfig.platformName;
  }
  if (Array.isArray(runtimeConfig.allowedPlatforms) && runtimeConfig.allowedPlatforms.length > 0) {
    nextRuntimeConfig.allowedPlatforms = runtimeConfig.allowedPlatforms;
  }
  if (Array.isArray(runtimeConfig.woolPlatforms)) {
    nextRuntimeConfig.woolPlatforms = runtimeConfig.woolPlatforms;
  }
  if (String(runtimeConfig.targetUrl || '').trim()) {
    nextRuntimeConfig.targetUrl = runtimeConfig.targetUrl;
  }
  if (String(runtimeConfig.tutorialUrl || '').trim()) {
    nextRuntimeConfig.tutorialUrl = runtimeConfig.tutorialUrl;
  }
  if (String(options.serverBase || '').trim()) {
    nextRuntimeConfig.serverBase = options.serverBase;
  }
  return nextRuntimeConfig;
}

function setLicenseRuntimeConfig(licenseCache, runtimeConfig = {}, options = {}) {
  if (!licenseCache || typeof licenseCache.setRuntimeConfig !== 'function') {
    return null;
  }
  const nextRuntimeConfig = buildLicenseRuntimeConfigPatch(runtimeConfig, options);
  if (Object.keys(nextRuntimeConfig).length <= 0) {
    return null;
  }
  licenseCache.setRuntimeConfig(nextRuntimeConfig);
  return nextRuntimeConfig;
}

module.exports = {
  setLicenseRuntimeConfig,
};
