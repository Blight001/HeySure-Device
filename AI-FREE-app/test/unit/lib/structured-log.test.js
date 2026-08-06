// 单元测试：lib/structured-log.js 结构化日志。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.join(__dirname, '..', '..', '..');
const { createStructuredLogger } = require(path.join(root, 'src', 'app', 'main', 'lib', 'structured-log.js'));

function capture() {
  const lines = { log: [], warn: [], error: [] };
  return {
    lines,
    logger: {
      log: (msg) => lines.log.push(msg),
      warn: (msg) => lines.warn.push(msg),
      error: (msg) => lines.error.push(msg),
    },
  };
}

test('输出 [domain] operation {json}，标准字段优先', () => {
  const { lines, logger } = capture();
  const slog = createStructuredLogger(logger, { domain: 'network' });
  slog.info('clash-start', { channel: 'start-clash-mini', correlationId: 'abc', extra: 1 });
  assert.equal(lines.log.length, 1);
  assert.match(lines.log[0], /^\[network\] clash-start \{/);
  const json = JSON.parse(lines.log[0].slice('[network] clash-start '.length));
  assert.deepEqual(json, { correlationId: 'abc', channel: 'start-clash-mini', extra: 1 });
});

test('无字段时只输出 [domain] operation', () => {
  const { lines, logger } = capture();
  createStructuredLogger(logger, { domain: 'ai' }).warn('chat-stop');
  assert.deepEqual(lines.warn, ['[ai] chat-stop']);
});

test('errorCode 落入 error 级输出', () => {
  const { lines, logger } = capture();
  createStructuredLogger(logger, { domain: 'updates' }).error('download-failed', { errorCode: 'NETWORK_TIMEOUT' });
  assert.equal(lines.error.length, 1);
  assert.ok(lines.error[0].includes('"errorCode":"NETWORK_TIMEOUT"'));
});

test('底层 logger 缺少级别时回退 log，且不抛错', () => {
  const seen = [];
  const slog = createStructuredLogger({ log: (m) => seen.push(m) }, { domain: 'x' });
  assert.doesNotThrow(() => slog.error('boom'));
  assert.deepEqual(seen, ['[x] boom']);
});
