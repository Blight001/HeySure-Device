const fs = require('fs');
const accountStorage = require('../../lib/account-storage');
const { getStorePath, getServerBase } = require('../../config');
const { initializeAccountCleanup, updateAccountRecycleTimer } = require('../../utils/accountCleanup');
const { cleanupAccountProfile } = require('../../services/account-profile-cleanup');
const {
  resolveDreamTargetUrl: resolveConfiguredDreamTargetUrl,
} = require('../../utils/account-records');
const { registerDreamPlatformIpc } = require('../../features/account/register-dream-platform-ipc');
const { createLicenseIpcHandlers } = require('../../features/account/license-ipc-handlers');

function registerLicenseIPC(ctx) {
  const ipc = ctx.ipc.scope('register/license');
  const resolveDreamTargetUrl = () => resolveConfiguredDreamTargetUrl(
    ctx.getDreamTargetUrl,
    ctx.DREAM_TARGET_URL,
  );
  const dream = registerDreamPlatformIpc({
    ipc,
    auth: ctx.auth,
    ui: ctx.ui,
    licenseCache: ctx.licenseCache,
    resolveDreamTargetUrl,
  });
  const handlers = createLicenseIpcHandlers({
    ...ctx,
    ...dream,
    accountStorage,
    cleanupAccountProfile,
    fs,
    getServerBase,
    getStorePath,
    initializeAccountCleanup,
    updateAccountRecycleTimer,
  });

  ipc.handle('refresh-wool-platforms', handlers.refreshWoolPlatforms);
  ipc.handle('refresh-tutorial-url', handlers.refreshTutorialUrl);
  ipc.handle('unbind-device', handlers.unbindDevice);
  ipc.handle('refresh-subscription-url', handlers.refreshSubscriptionUrl);
}

module.exports = { registerLicenseIPC };
