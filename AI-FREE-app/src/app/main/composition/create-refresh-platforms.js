'use strict';

function readPlatformRuntimeConfig(deps) {
  const raw = typeof deps.licenseCache?.getRuntimeConfig === 'function'
    ? deps.licenseCache.getRuntimeConfig() : {};
  const normalized = deps.normalizeValidationRuntimeConfig(raw);
  const allowedPlatforms = Array.isArray(normalized.allowedPlatforms) ? normalized.allowedPlatforms : [];
  const woolPlatforms = Array.isArray(normalized.woolPlatforms) ? normalized.woolPlatforms : [];
  return {
    allowedPlatforms,
    woolPlatforms,
    platformName: String(normalized.platformName || allowedPlatforms[0] || '').trim(),
    targetUrl: String(normalized.targetUrl || '').trim(),
    tutorialUrl: String(normalized.tutorialUrl || '').trim(),
  };
}

function isEmptyPlatformConfig(config) {
  return !config.platformName && !config.allowedPlatforms.length && !config.targetUrl && !config.tutorialUrl;
}

function persistPlatformConfig(deps, config) {
  try {
    if (typeof deps.licenseCache?.setRuntimeConfig === 'function') {
      deps.licenseCache.setRuntimeConfig({
        allowedPlatforms: config.allowedPlatforms,
        woolPlatforms: config.woolPlatforms,
        platformName: config.platformName,
      });
    }
  } catch (error) {
    console.warn('[启动] 保存平台列表失败:', error?.message || error);
  }
}

function syncPlatformTargetUrl(deps, targetUrl) {
  if (!targetUrl) return;
  try {
    deps.setDreamTargetUrl(targetUrl);
    deps.sendToSide('target-url-updated', { targetUrl });
  } catch (error) {
    console.warn('[启动] 同步目标地址失败:', error?.message || error);
  }
}

async function syncPlatformTutorialUrl(deps, tutorialUrl) {
  if (!tutorialUrl) return;
  try {
    deps.sendToSide('tutorial-url-updated', { tutorialUrl });
    const syncTutorialTabUrl = deps.getSyncTutorialTabUrl();
    if (typeof syncTutorialTabUrl === 'function') await syncTutorialTabUrl(tutorialUrl);
  } catch (error) {
    console.warn('[启动] 同步教程地址失败:', error?.message || error);
  }
}

function notifyPlatformLists(deps, config) {
  deps.sendToSide('platform-name-updated', {
    platformName: config.platformName,
    allowedPlatforms: config.allowedPlatforms,
    woolPlatforms: config.woolPlatforms,
  });
  deps.sendToSide('wool-platforms-updated', { woolPlatforms: config.woolPlatforms });
}

async function performPlatformRefresh(deps) {
  const config = readPlatformRuntimeConfig(deps);
  if (isEmptyPlatformConfig(config)) return;
  deps.appRuntime.setLatestAllowedPlatforms(config.allowedPlatforms);
  persistPlatformConfig(deps, config);
  syncPlatformTargetUrl(deps, config.targetUrl);
  await syncPlatformTutorialUrl(deps, config.tutorialUrl);
  notifyPlatformLists(deps, config);
  console.log('[启动] 平台名称已刷新并通知侧边栏:', config.platformName);
}

function createRefreshAllowedPlatformsAndNotify(deps) {
  let platformRefreshInFlight = false;
  return async function refreshAllowedPlatformsAndNotify() {
    if (platformRefreshInFlight) return;
    platformRefreshInFlight = true;
    try {
      await performPlatformRefresh(deps);
    } catch (error) {
      console.warn('[启动] 刷新平台名称失败:', error?.message || error);
    } finally {
      platformRefreshInFlight = false;
    }
  };
}

module.exports = { createRefreshAllowedPlatformsAndNotify };
