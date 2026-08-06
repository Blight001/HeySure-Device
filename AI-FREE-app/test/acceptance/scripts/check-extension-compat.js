'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildElectronExtensionCompatShim } = require('../../../src/app/main/features/extensions/electron-compat-shim');

const shim = buildElectronExtensionCompatShim('test marker');
const updated = [];
const chrome = {
  runtime: {},
  scripting: { executeScript: async () => [{ result: true }] },
  storage: { local: { get: async () => ({}), set: async () => {} } },
  tabs: {
    query(_info, callback) {
      const tabs = [{ id: 7, url: 'https://example.com/', title: 'Example' }];
      if (callback) callback(tabs);
      return Promise.resolve(tabs);
    },
    update(id, info, callback) {
      updated.push({ id, info });
      const tab = { id, url: info.url || 'https://example.com/' };
      if (callback) callback(tab);
      return Promise.resolve(tab);
    },
  },
};

const context = vm.createContext({ chrome, Promise, Map, Set, URL, setTimeout, clearTimeout });
new vm.Script(shim, { filename: 'electron-extension-compat.js' }).runInContext(context);

(async () => {
  const queried = await chrome.tabs.query({ active: true, currentWindow: true });
  assert.equal(queried[0].active, true);
  assert.equal(queried[0].windowId, 1);
  assert.equal((await chrome.tabs.get(7)).id, 7);
  assert.equal((await chrome.tabs.create({ url: 'https://openai.com/' })).id, 7);
  assert.equal(updated.at(-1).id, 7);
  assert.equal(updated.at(-1).info.url, 'https://openai.com/');
  assert.equal(chrome.storage.session, chrome.storage.local);
  assert.equal(typeof chrome.windows.getCurrent, 'function');
  assert.equal(typeof chrome.downloads.download, 'function');
  assert.equal(typeof chrome.alarms.create, 'function');
  console.log('Extension compatibility shim checks passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
