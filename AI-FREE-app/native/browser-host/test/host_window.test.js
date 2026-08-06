const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');

const bindingPath = path.join(__dirname, '..', 'build', 'Release', 'browser_host.node');

test('native host exports the documented API', { skip: !fs.existsSync(bindingPath) && 'native addon has not been built' }, () => {
  const binding = require(bindingPath);
  for (const name of [
    'createHostWindow', 'destroyHostWindow', 'attachChildWindow', 'detachChildWindow',
    'setHostBounds', 'raiseHostWindow', 'showHostWindow', 'hideHostWindow', 'focusChildWindow',
    'releaseChildWindowFocus',
    'isWindowAlive', 'getWindowProcessId', 'findMainWindowByProcessId',
    'setChildWindowTitle', 'isChildWindowAttached',
  ]) {
    assert.equal(typeof binding[name], 'function', `${name} must be exported`);
  }
});

const dpiTestPath = path.join(__dirname, '..', 'build', 'Release', 'dpi_scaling_test.exe');

test('DIP bounds scale to physical pixels at common Windows display factors', {
  skip: !fs.existsSync(dpiTestPath) && 'native DPI regression test has not been built',
}, () => {
  const result = spawnSync(dpiTestPath, [], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || `DPI regression test exited with ${result.status}`);
});
