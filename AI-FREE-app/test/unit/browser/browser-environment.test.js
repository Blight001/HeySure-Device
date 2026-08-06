'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveChromiumExtensionPaths } = require('../../../src/app/main/features/browser/browser-environment');

test('Chromium launch excludes the legacy automation extension while preserving regular extensions', () => {
  const manager = {
    getEnabledExtensionPaths: () => [
      'D:\\assets\\extensions\\browser_automation',
      'D:\\assets\\extensions\\transform',
    ],
  };
  assert.deepEqual(resolveChromiumExtensionPaths({
    chromiumExtensionPaths: [
      'D:\\custom\\browser_automation\\',
      'D:\\custom\\regular-extension',
    ],
  }, manager), [
    'D:\\assets\\extensions\\transform',
    'D:\\custom\\regular-extension',
  ]);
});
