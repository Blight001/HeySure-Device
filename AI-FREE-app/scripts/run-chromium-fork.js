'use strict';

// Production-equivalent launcher: only the staged AI-FREE Chromium Fork is
// accepted and the authenticated Named Pipe handshake is mandatory.
process.env.AI_FREE_BROWSER_RUNTIME = 'chromium';
process.env.AI_FREE_CHROMIUM_REQUIRED = '1';
delete process.env.AI_FREE_CHROMIUM_HANDSHAKE;
delete process.env.AI_FREE_CHROMIUM_PATH;

console.log('[ChromiumRuntime] 正式 Fork 模式：打包内核 + Named Pipe 握手，禁止系统浏览器回退');
require('./run-electron');
