'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const axiosPath = require.resolve('axios');
const targetPath = require.resolve('../../../src/app/main/features/network/clash-mini-control-impl');
const requests = [];
let responder = async (options) => ({ status: 200, data: { options } });
const axiosStub = async (options) => {
  requests.push(options);
  return responder(options);
};
axiosStub.get = async (url, options) => axiosStub({ method: 'get', url, ...options });
require.cache[axiosPath] = { exports: axiosStub };
delete require.cache[targetPath];
const clash = require(targetPath);

test('runtime config parsing derives proxy and controller settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-clash-control-'));
  try {
    const configPath = path.join(root, 'config.yaml');
    fs.writeFileSync(configPath, [
      'mixed-port: 17890',
      'external-controller: 127.0.0.2:19090',
      'secret: control-secret',
      'proxies:',
      '  - name: Node A',
      '  - name: Node B',
      'proxy-groups:',
      '  - name: Manual',
      '    type: select',
      '    proxies: [Node A, Node B]',
      'rules: [MATCH,Manual]',
    ].join('\n'));
    assert.equal(clash.looksLikeRuntimeClashConfig(fs.readFileSync(configPath, 'utf8')), true);
    assert.equal(clash.looksLikeRuntimeClashConfig('invalid: ['), false);
    assert.equal(clash.looksLikeProfilesIndex({ items: [] }), true);
    assert.equal(clash.looksLikeProfilesIndex({ uid: 'u', type: 'local', file: 'a.yaml' }), true);
    assert.equal(clash.looksLikeProfilesIndex({ proxies: [] }), false);
    assert.equal(clash.readYamlIfExists(configPath)['mixed-port'], 17890);
    assert.equal(clash.readYamlIfExists(path.join(root, 'missing.yaml')), null);
    assert.equal(clash.readClashMiniRuntimeConfig(root).secret, 'control-secret');
    assert.deepEqual(clash.getClashMiniProxyEndpoint(root), { host: '127.0.0.1', port: 17890 });
    assert.deepEqual(clash.getClashMiniControlEndpoint(root), { host: '127.0.0.2', port: 19090 });
    assert.equal(clash.getClashMiniControlSecret(root), 'control-secret');
    assert.equal(clash.getClashMiniManualGroupName(root), 'Manual');
    assert.deepEqual(clash.getClashMiniConfigProxyNames(root), ['Node A', 'Node B']);
    assert.equal(clash.buildClashMiniControlUrl(root, 'configs'), 'http://127.0.0.2:19090/configs');
    assert.deepEqual(clash.buildClashMiniControlHeaders(root), { Authorization: 'Bearer control-secret' });

    fs.writeFileSync(path.join(root, 'config.yaml'), 'port: 18080\nexternal-controller: invalid\n');
    const otherRoot = path.join(root, 'other');
    fs.mkdirSync(otherRoot);
    fs.copyFileSync(path.join(root, 'config.yaml'), path.join(otherRoot, 'self.yaml'));
    assert.equal(clash.getClashMiniProxyEndpoint(otherRoot).port, 18080);
    assert.equal(clash.getClashMiniControlEndpoint(otherRoot).port, 9090);
    assert.deepEqual(clash.buildClashMiniControlHeaders(otherRoot), {});
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('delay and proxy normalizers handle nested API response shapes', () => {
  assert.equal(clash.extractDelayValue(12), 12);
  assert.equal(clash.extractDelayValue('23.5 ms'), 23.5);
  assert.equal(clash.extractDelayValue({ delay: '44ms' }), 44);
  assert.equal(clash.extractDelayValue({ latency: 55 }), 55);
  assert.equal(clash.extractDelayValue({ history: { delay: 66 } }), 66);
  assert.equal(clash.extractDelayValue(-1), null);
  assert.equal(clash.extractDelayValue('timeout'), null);
  assert.deepEqual(
    clash.normalizeProxyNameList({ all: ['A', 'B', 'A'], nested: { nodes: [{ name: 'C' }], now: 'B' } }),
    ['A', 'B', 'C'],
  );
  assert.equal(clash.formatClashMiniDelayText(10.6), '11ms');
  assert.equal(clash.formatClashMiniDelayText(0), '超时');
});

test('control requests validate status and rule mode changes only when needed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-clash-api-'));
  fs.writeFileSync(path.join(root, 'config.yaml'), 'external-controller: 127.0.0.1:9090\nsecret: fixture\n');
  try {
    requests.length = 0;
    responder = async (options) => ({ status: 200, data: options.method === 'get' ? { mode: 'global' } : { ok: true } });
    const changed = await clash.ensureClashMiniRuleMode(root);
    assert.deepEqual(changed, { ok: true, changed: true, mode: 'rule', previousMode: 'global' });
    assert.deepEqual(requests.map((item) => item.method), ['get', 'patch']);
    assert.deepEqual(requests[1].data, { mode: 'rule' });

    responder = async () => ({ status: 200, data: { mode: 'rule' } });
    assert.deepEqual(await clash.ensureClashMiniRuleMode(root), { ok: true, changed: false, mode: 'rule' });
    responder = async () => ({ status: 403, data: { error: 'denied' } });
    await assert.rejects(clash.invokeClashMiniControl(root, 'get', '/configs'), /denied/);
    const failure = await clash.ensureClashMiniRuleMode(root);
    assert.equal(failure.ok, false);
    assert.match(failure.error, /denied/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('proxy discovery resolves nested groups and delay probes retain failures', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-clash-proxy-'));
  fs.writeFileSync(path.join(root, 'config.yaml'), [
    'external-controller: 127.0.0.1:9090',
    'proxies:',
    '  - name: A',
    '  - name: B',
  ].join('\n'));
  try {
    responder = async (options) => {
      if (options.url.includes('/proxies/Manual')) return { status: 200, data: { all: ['Nested', 'A', 'Unknown'], now: 'Nested' } };
      if (options.url.includes('/proxies/Nested')) return { status: 200, data: { now: 'B' } };
      if (options.url.includes('/proxies/A/delay')) return { status: 200, data: { delay: 42 } };
      if (options.url.includes('/proxies/B/delay')) return { status: 504, data: { message: 'timeout' } };
      if (options.url.includes('/group/')) return { status: 200, data: { A: 20, B: 30 } };
      return { status: 200, data: {} };
    };
    const discovered = await clash.fetchClashMiniProxyNames(root, 'Manual');
    assert.deepEqual(discovered.names, ['A', 'B']);
    assert.equal(discovered.current, 'B');
    assert.equal((await clash.probeClashMiniProxyDelay(root, 'A', 'https://probe.test', 1000)).delay, 42);
    assert.deepEqual(await clash.probeClashMiniGroupDelay(root, 'Manual', 'https://probe.test', 1000), { A: 20, B: 30 });
    const entries = await clash.collectClashMiniProxyDelays(root, ['A', 'B', 'A'], 'https://probe.test', 1000, 2);
    assert.deepEqual(entries.map((entry) => [entry.name, entry.ok]), [['A', true], ['B', false]]);
    assert.deepEqual(await clash.collectClashMiniProxyDelays(root, [], 'https://probe.test', 1000), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
