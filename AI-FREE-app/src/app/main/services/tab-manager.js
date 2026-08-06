const {
  resolveChromiumExtensionPaths,
} = require('../features/browser/browser-environment');
const { createTabManagerRuntime } = require('./tab-manager-runtime');

function createTabManager(deps = {}) {
  return createTabManagerRuntime(deps);
}

module.exports = {
  createTabManager,
  resolveChromiumExtensionPaths,
};
