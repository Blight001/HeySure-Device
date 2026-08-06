'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const JavaScriptObfuscator = require('javascript-obfuscator');

const {
  buildObfuscationOptions,
} = require('../../scripts/obfuscate-packaged-extensions');
const obfuscatePackagedExtensions = require('../../scripts/obfuscate-packaged-extensions').default;

test('executeScript host files keep serialized page functions self-contained', async () => {
  const source = `
    async function invokePage() {
      return chrome.scripting.executeScript({
        target: { tabId: 1 },
        args: ['scan'],
        func: (method) => {
          if (!window.__pageApi || typeof window.__pageApi[method] !== 'function') {
            return { missing: true };
          }
          return window.__pageApi[method]();
        },
      });
    }
  `;
  const options = buildObfuscationOptions(source);
  assert.equal(options.stringArray, false);

  const obfuscated = JavaScriptObfuscator.obfuscate(source, options).getObfuscatedCode();
  const workerContext = vm.createContext({
    chrome: {
      scripting: {
        executeScript: async ({ func, args }) => {
          const pageFunction = vm.runInNewContext(`(${func.toString()})`, {
            window: { __pageApi: { scan: () => 'observed-page-content' } },
          });
          return pageFunction(...args);
        },
      },
    },
  });

  vm.runInContext(obfuscated, workerContext);
  assert.equal(await vm.runInContext('invokePage()', workerContext), 'observed-page-content');
});

test('packaging without configured extensions accepts an absent extension directory', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-no-packaged-extensions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.doesNotReject(obfuscatePackagedExtensions({ appOutDir: root }));
});
