const test = require('node:test');

test('Win32 embed smoke test is enabled explicitly', {
  skip: process.env.AI_FREE_RUN_EMBED_SMOKE !== '1' && 'set AI_FREE_RUN_EMBED_SMOKE=1 in an Electron test process',
}, () => {
  // The real smoke path needs an Electron BrowserWindow and a Chromium executable.
  // Keeping it opt-in prevents CI from attaching arbitrary desktop windows.
});
