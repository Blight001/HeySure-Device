'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const commandClient = fs.readFileSync(
  path.join(root, 'src/app/main/browser-runtime/chromium-command-client.js'), 'utf8',
);
const runtimeAutomation = fs.readFileSync(
  path.join(root, 'src/app/main/browser-runtime/runtime-automation.js'), 'utf8',
);
const nativeAutomation = fs.readFileSync(
  path.join(root, 'src/app/main/services/native-browser-automation.js'), 'utf8',
);
const observePatch = fs.readFileSync(
  path.join(root, 'native/chromium-fork/patches/0020-ai-free-page-automation.patch'), 'utf8',
);

assert(commandClient.includes("'observe-page'"));
assert(runtimeAutomation.includes("name === 'observe-page'"));
assert(nativeAutomation.includes("runtimeCommand(connection, 'observe-page'"));
assert(observePatch.includes('observe-page'));
assert(observePatch.includes('perform-action'));
assert(!fs.existsSync(path.join(root, 'src/assets/extensions/browser_automation')));

console.log('native Chromium browser observe checks passed');
