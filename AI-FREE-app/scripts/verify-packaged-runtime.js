'use strict';

const runtimeChecks = require('../test/acceptance/scripts/verify-packaged-runtime');

if (require.main === module) {
  try {
    runtimeChecks.verifyPackagedRuntime();
  } catch (error) {
    console.error(`[packaged-runtime] ${error?.stack || error}`);
    process.exit(1);
  }
}

module.exports = runtimeChecks;
