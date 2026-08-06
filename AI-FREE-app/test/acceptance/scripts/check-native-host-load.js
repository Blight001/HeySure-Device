'use strict';

const path = require('path');

const bindingPath = path.resolve(
  process.env.BROWSER_HOST_BINDING_PATH
    || path.join(__dirname, '../../../native/browser-host/build/Release/browser_host.node'),
);
const binding = require(bindingPath);
console.log(JSON.stringify({
  bindingPath,
  electron: process.versions.electron || '',
  node: process.versions.node,
  napi: process.versions.napi,
  createHostWindow: typeof binding.createHostWindow,
}));

if (typeof binding.createHostWindow !== 'function') {
  throw new Error('Native browser host API is incomplete');
}

if (process.versions.electron) {
  require('electron').app.quit();
}
