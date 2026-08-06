'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

let roots = [];
let requestFactory = null;
const electronPath = require.resolve('electron');
const assetsPath = require.resolve('../../../src/app/main/features/network/clash-mini-assets');
const targetPath = require.resolve('../../../src/app/main/features/network/clash-mini-latency-probe');
require.cache[electronPath] = { exports: { net: { request: (options) => requestFactory(options) } } };
require.cache[assetsPath] = { exports: { getClashMiniProfileRoots: () => roots } };
delete require.cache[targetPath];
const probe = require(targetPath);

function createRequest(onEnd) {
  const request = new EventEmitter();
  request.abort = () => { request.aborted = true; };
  request.end = () => onEnd(request);
  return request;
}

test.beforeEach(() => { roots = []; requestFactory = null; });

test('probe option normalizers clamp timeouts and reject unsafe URLs', () => {
  assert.equal(probe.normalizeProbeTimeout('30'), 200);
  assert.equal(probe.normalizeProbeTimeout(250.4), 250);
  assert.equal(probe.normalizeProbeTimeout('bad', 900), 900);
  assert.equal(probe.normalizeProbeUrl('https://example.test/check'), 'https://example.test/check');
  assert.equal(probe.normalizeProbeUrl('http://example.test/check'), probe.DEFAULT_LATENCY_PROBE_URL);
  assert.equal(probe.normalizeProbeUrl('file:///tmp/a', 'https://fallback.test'), 'https://fallback.test');
  assert.equal(probe.normalizeProbeUrl('bad', ''), '');
});

test('profile settings support indexed profile files and malformed root fallback', () => {
  const invalidRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-probe-invalid-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-probe-'));
  try {
    fs.writeFileSync(path.join(invalidRoot, 'profiles.yaml'), 'invalid: [', 'utf8');
    fs.mkdirSync(path.join(root, 'profiles'));
    fs.writeFileSync(path.join(root, 'profiles.yaml'), [
      'current: profile-one',
      'items:',
      '  - uid: profile-one',
      '    name: Fixture Profile',
      '    file: fixture.yaml',
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'profiles', 'fixture.yaml'), [
      'cfw-latency-timeout: 1350',
      'cfw-latency-url: https://probe.example.test/204',
      'cfw-conn-break-strategy: true',
    ].join('\n'));
    roots = [invalidRoot, root];
    const result = probe.readClashProbeSettings();
    assert.equal(result.profileName, 'Fixture Profile');
    assert.equal(result.profileUid, 'profile-one');
    assert.equal(result.latencyTimeoutMs, 1350);
    assert.equal(result.latencyUrl, 'https://probe.example.test/204');
    assert.equal(result.connBreakStrategy, true);
  } finally {
    fs.rmSync(invalidRoot, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(probe.readClashProbeSettings(), null);
});

test('latency probe resolves successful and aborted responses once', async () => {
  requestFactory = (options) => createRequest((request) => {
    assert.equal(options.method, 'GET');
    const response = new EventEmitter();
    response.statusCode = 204;
    response.resume = () => {};
    request.emit('response', response);
    response.emit('end');
    response.emit('aborted');
  });
  const success = await probe.probeLatencyUrl('https://probe.example.test', 1000);
  assert.equal(success.ok, true);
  assert.equal(success.statusCode, 204);

  requestFactory = () => createRequest((request) => {
    const response = new EventEmitter();
    response.statusCode = 502;
    response.resume = () => {};
    request.emit('response', response);
    response.emit('aborted');
  });
  const aborted = await probe.probeLatencyUrl('https://probe.example.test', 1000);
  assert.equal(aborted.ok, false);
  assert.equal(aborted.error, '响应已中止');
  assert.equal(aborted.statusCode, 502);
});

test('latency probe handles request errors, response errors and constructor failures', async () => {
  requestFactory = () => createRequest((request) => request.emit('error', new Error('connect failed')));
  assert.equal((await probe.probeLatencyUrl('https://probe.example.test')).error, 'connect failed');

  requestFactory = () => createRequest((request) => {
    const response = new EventEmitter();
    response.statusCode = 500;
    response.resume = () => {};
    request.emit('response', response);
    response.emit('error', new Error('body failed'));
  });
  assert.equal((await probe.probeLatencyUrl('https://probe.example.test')).error, 'body failed');

  requestFactory = () => { throw new Error('factory failed'); };
  assert.equal((await probe.probeLatencyUrl('https://probe.example.test')).error, 'factory failed');
  assert.deepEqual(await probe.probeLatencyUrl('', 200), {
    ok: false, error: 'latency url missing', elapsedMs: 0, statusCode: null,
  });
});

test('latency probe times out and aborts the pending request', async () => {
  let pending;
  requestFactory = () => {
    pending = createRequest(() => {});
    return pending;
  };
  const result = await probe.probeLatencyUrl('https://probe.example.test', 10);
  assert.equal(result.ok, false);
  assert.match(result.error, /请求超时/);
  assert.equal(pending.aborted, true);
});
