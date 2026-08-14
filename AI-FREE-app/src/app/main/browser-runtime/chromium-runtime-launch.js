'use strict';

const { cleanupFailedChromiumLaunch } = require('./chromium-runtime-process');
const { createChromiumPerformanceSpan } = require('./chromium-performance');
const { RUNTIME_STATUS } = require('./runtime-types');

async function showExistingProfile(runtime, profileId, rawBounds) {
  const span = createChromiumPerformanceSpan(runtime.logger, 'runtime-show');
  try {
    await runtime.resize(profileId, rawBounds);
    span.mark('resize');
    await runtime.show(profileId);
    span.mark('show');
    span.finish();
    return runtime.getState(profileId);
  } catch (error) {
    span.fail(error);
    throw error;
  }
}

function stopOwnsLaunchCleanup(runtime, profileId, error) {
  const state = runtime.store.getState(profileId);
  return error?.code === 'CHROMIUM_LAUNCH_CANCELLED'
    && [RUNTIME_STATUS.STOPPING, RUNTIME_STATUS.STOPPED].includes(state?.status);
}

async function cleanupLaunchFailure(runtime, profileId, context, error, span) {
  if (!stopOwnsLaunchCleanup(runtime, profileId, error)) {
    await cleanupFailedChromiumLaunch(runtime, profileId, {
      hostHwnd: context.hostHwnd,
      commandClient: context.commandClient,
      error,
    });
    span.mark('failureCleanup');
  }
}

async function launchChromiumProfile(runtime, rawProfile = {}, rawBounds = {}) {
  const profileId = String(rawProfile.profileId || rawProfile.id || '').trim();
  if (!profileId) throw new Error('缺少 Profile ID');
  if (runtime.isProfileVisible(profileId)) {
    return showExistingProfile(runtime, profileId, rawBounds);
  }
  const span = createChromiumPerformanceSpan(runtime.logger, 'runtime-launch');
  let context;
  try {
    context = runtime.prepareProfileLaunch(profileId, rawProfile, rawBounds, span);
    const instance = await runtime.createProfileInstance(context);
    await runtime.completeProfileLaunch(profileId, instance, context.bounds);
    span.finish();
    return runtime.getState(profileId);
  } catch (error) {
    if (context) await cleanupLaunchFailure(runtime, profileId, context, error, span);
    span.fail(error);
    throw error;
  }
}

module.exports = { launchChromiumProfile };
