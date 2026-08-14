'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('browser settings distinguish the device-memory fingerprint from real memory usage', () => {
  const page = fs.readFileSync(
    path.join(__dirname, '../../../src/app/views/app-shell.html'),
    'utf8',
  );
  const memoryRow = page.match(/<div class="vb-row"><label[^>]+for="browser-memory"[\s\S]*?<\/div><\/div>/)?.[0] || '';
  assert.match(memoryRow, />设备内存指纹<\/label>/);
  assert.match(memoryRow, /仅影响网页可见的设备信息，不限制浏览器实际内存占用。/);
  const tooltip = fs.readFileSync(
    path.join(__dirname, '../../../src/app/renderer/controllers/pages/app-shell/tabs-tooltip.js'),
    'utf8',
  );
  assert.match(tooltip, /设备内存指纹：/);
});
