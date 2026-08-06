const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  isChromiumExtraResource,
  isClashCoreExtraResource,
  isDeferredExtraResource,
} = require('../../scripts/build-windows');

test('Windows build defers Chromium and Clash Mini Core resources', () => {
  const chromium = { from: 'resources\\chromium', to: 'chromium' };
  const clashCore = { from: 'resources/clash-mini/core', to: 'clash-mini/core' };
  const nativeHost = { from: 'native/browser-host/build/Release/browser_host.node' };

  assert.equal(isChromiumExtraResource(chromium), true);
  assert.equal(isClashCoreExtraResource(clashCore), true);
  assert.equal(isDeferredExtraResource(chromium), true);
  assert.equal(isDeferredExtraResource(clashCore), true);
  assert.equal(isDeferredExtraResource(nativeHost), false);
});

test('staging uses a standalone config so electron-builder cannot append deferred resources', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../scripts/build-windows.js'), 'utf8');

  assert.match(source, /const stageConfigPath = writeStageConfigFile\(appOutDir, stageConfig\)/);
  assert.match(source, /config:\s*stageConfigPath/);
  assert.match(source, /finally\s*{\s*fs\.rmSync\(stageConfigPath,\s*{ force: true }\)/);
  assert.doesNotMatch(source, /config:\s*stageConfig[,\s]/);
});
