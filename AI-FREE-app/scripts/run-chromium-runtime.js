'use strict';

// Development launcher for the Win32 embedded Chromium runtime. Production
// builds use the fork handshake and do not enable prototype window discovery.
process.env.AI_FREE_BROWSER_RUNTIME = 'chromium';
process.env.AI_FREE_CHROMIUM_HANDSHAKE = 'prototype';
process.env.AI_FREE_CHROMIUM_REQUIRED = '1';

console.log('[ChromiumRuntime] 开发验证模式已启用（prototype handshake，禁止静默回退）');
require('./run-electron');
