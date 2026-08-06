'use strict';

const fs = require('fs');
const accountStorage = require('../../lib/account-storage');
const { getStorePath } = require('../../config');
const { isUsageExhaustedFetchError } = require('../../utils/account-errors');
const { findAccountRecord, isPermanentAccountRecord } = require('../../utils/account-records');
const { updateAccountRecycleTimer } = require('../../utils/accountCleanup');
const { cleanupAccountProfile } = require('../../services/account-profile-cleanup');
const { createDreamPlatformSupport } = require('./dream-platform-support');
const { createOpenDreamPageHandler } = require('./open-dream-page-handler');

function registerDreamPlatformIpc(deps = {}) {
  const support = createDreamPlatformSupport({
    ...deps,
    accountStorage,
    cleanupAccountProfile,
    findAccountRecord,
    fs,
    getStorePath,
    isPermanentAccountRecord,
    updateAccountRecycleTimer,
  });
  const openDreamPage = createOpenDreamPageHandler({
    ...deps,
    accountStorage,
    isUsageExhaustedFetchError,
    support,
    updateAccountRecycleTimer,
  });
  deps.ipc.handle('open-dream-page', openDreamPage);
  return {
    buildAccountCleanupOptions: support.buildAccountCleanupOptions,
    resolveRuntimeConnectionConfig: support.resolveRuntimeConnectionConfig,
  };
}

module.exports = { registerDreamPlatformIpc };
