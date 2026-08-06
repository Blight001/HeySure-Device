const test = require('node:test');
const assert = require('node:assert/strict');

const { createAppConsoleBridge } = require('../../src/app/main/runtime/app-console');
const {
  isClashMiniNetworkRequestLog,
} = require('../../src/app/main/ipc/register/clash-mini-core');

test('debug-only network logs are isolated from regular console history and senders', () => {
  const regularLines = [];
  const debugLines = [];
  const bridge = createAppConsoleBridge({
    getSenders: () => [{ send: (_channel, entry) => regularLines.push(entry) }],
    getDebugSenders: () => [{ send: (_channel, entry) => debugLines.push(entry) }],
  });

  bridge.pushDebugOnly('warn', [
    '[Clash Mini]',
    'time="2026-07-15" level=warning msg="[TCP] dial DIRECT timeout"',
    { stream: 'stdout' },
  ]);

  assert.equal(regularLines.length, 0);
  assert.equal(bridge.getHistory().length, 0);
  assert.equal(debugLines.length, 1);
  assert.equal(bridge.getDebugHistory().length, 1);
  assert.match(debugLines[0].text, /^\[Clash Mini\].*\[TCP\]/);
});

test('only Mihomo network request stream lines use the exclusive debug route', () => {
  assert.equal(isClashMiniNetworkRequestLog(
    'time="2026-07-15" level=info msg="[TCP] 127.0.0.1:1 --> example.com:443"',
    { stream: 'stdout' },
  ), true);
  assert.equal(isClashMiniNetworkRequestLog(
    'time="2026-07-15" level=info msg="[UDP] 127.0.0.1:1 --> 8.8.8.8:53"',
    { stream: 'stdout' },
  ), true);
  assert.equal(isClashMiniNetworkRequestLog('Clash Meta started', { stream: 'stdout' }), false);
  assert.equal(isClashMiniNetworkRequestLog('[TCP] lifecycle text without child stream', {}), false);
});
