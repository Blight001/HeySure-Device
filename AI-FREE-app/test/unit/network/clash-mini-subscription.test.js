'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');

const assetsPath = require.resolve('../../../src/app/main/features/network/clash-mini-assets');
const geoPath = require.resolve('../../../src/app/main/features/network/clash-mini-geo-config');
const targetPath = require.resolve('../../../src/app/main/features/network/clash-mini-subscription');
require.cache[assetsPath] = { exports: {
  purgeClashMiniRuntimeConfigFiles: () => ({ removed: ['old.yaml'] }),
  syncLocalGeoAssets: () => ({ ok: true, missing: [] }),
} };
require.cache[geoPath] = { exports: {
  getClashMiniCompatibilitySummary: (normalized) => ({ mode: normalized.config.mode }),
  normalizeClashMiniStartupConfig: (config) => ({ config: { mode: 'rule', ...config } }),
} };
delete require.cache[targetPath];
const subscription = require(targetPath);

function vmess(overrides = {}) {
  const payload = {
    v: '2', ps: 'Fixture Node', add: 'node.example.test', port: '443', id: 'uuid-fixture',
    aid: '0', net: 'ws', host: 'cdn.example.test', path: '/socket', tls: 'tls', sni: 'sni.example.test',
    ...overrides,
  };
  return `vmess://${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
}

test('direct config extraction accepts legacy response containers and text', () => {
  const yaml = 'mixed-port: 7890\nproxies: []';
  assert.equal(subscription.extractDirectClashConfigContent(null), '');
  assert.equal(subscription.extractDirectClashConfigContent(`\uFEFF---\n${yaml}`), `---\n${yaml}`);
  assert.equal(subscription.extractDirectClashConfigContent(JSON.stringify({ config: yaml })), yaml);
  assert.equal(subscription.extractDirectClashConfigContent({ clashConfig: yaml }), yaml);
  assert.equal(subscription.extractDirectClashConfigContent({ clash_config: yaml }), yaml);
  assert.equal(subscription.extractDirectClashConfigContent({ data: yaml }), yaml);
  assert.equal(subscription.extractDirectClashConfigContent({ yaml_content: yaml }), yaml);
  assert.equal(subscription.extractDirectClashConfigContent({ red_yaml_content: yaml }), yaml);
  assert.equal(subscription.extractDirectClashConfigContent('plain text'), 'plain text');
});

test('base64 and name helpers reject malformed values and decode URL-safe content', () => {
  const text = 'vmess://fixture\n'.repeat(3);
  const encoded = Buffer.from(text).toString('base64');
  assert.equal(subscription.tryDecodeBase64Text(encoded), text.trim());
  assert.equal(subscription.tryDecodeBase64Text('short'), '');
  assert.equal(subscription.tryDecodeBase64Text('!'.repeat(32)), '');
  assert.equal(subscription.looksLikeSubscriptionPayload('  VMESS://abc'), true);
  assert.equal(subscription.looksLikeSubscriptionPayload('https://example.test'), false);
  assert.equal(subscription.decodeSubscriptionItemName('Node+One%20Two'), 'Node One Two');
  assert.equal(subscription.decodeSubscriptionItemName('%E0%A4%A'), '%E0%A4%A');
  assert.equal(subscription.safeBase64UrlDecode(Buffer.from('hello').toString('base64url')), 'hello');
  assert.equal(subscription.safeBase64UrlDecode(''), '');
  assert.equal(subscription.sanitizeProxyName('  Node   A  ', 'fallback'), 'Node A');
  assert.equal(subscription.sanitizeProxyName('', 'fallback'), 'fallback');
});

test('VMess parser maps transports, TLS and certificate options', () => {
  const websocket = subscription.parseVmessSubscriptionLine(vmess({ skip_cert_verify: 'true' }), 0);
  assert.equal(websocket.type, 'vmess');
  assert.equal(websocket.name, 'Fixture Node');
  assert.equal(websocket.network, 'ws');
  assert.equal(websocket['ws-opts'].path, '/socket');
  assert.deepEqual(websocket['ws-opts'].headers, { Host: 'cdn.example.test' });
  assert.equal(websocket.servername, 'sni.example.test');
  assert.equal(websocket['skip-cert-verify'], true);

  const http = subscription.parseVmessSubscriptionLine(vmess({ net: 'h2', path: '/h2', host: 'h2.example.test', tls: '' }), 1);
  assert.equal(http.network, 'http');
  assert.deepEqual(http['http-opts'].path, ['/h2']);
  const grpc = subscription.parseVmessSubscriptionLine(vmess({ net: 'grpc', path: '/service' }), 2);
  assert.equal(grpc['grpc-opts']['grpc-service-name'], 'service');
  const quic = subscription.parseVmessSubscriptionLine(vmess({ net: 'quic' }), 3);
  assert.equal(quic.network, 'quic');
  assert.equal(subscription.parseVmessSubscriptionLine('trojan://fixture', 0), null);
  assert.equal(subscription.parseVmessSubscriptionLine('vmess://bad', 0), null);
  assert.equal(subscription.parseVmessSubscriptionLine(vmess({ add: '', id: '' }), 0), null);
});

test('subscription conversion deduplicates comments and builds a runnable Clash config', () => {
  const lines = `# comment\n${vmess()}\ninvalid\n${vmess({ ps: 'Second', net: 'tcp' })}`;
  const proxies = subscription.parseSubscriptionProxyList(lines);
  assert.deepEqual(proxies.map((proxy) => proxy.name), ['Fixture Node', 'Second']);
  const config = subscription.buildClashRuntimeConfigFromSubscription(lines);
  assert.equal(config.mode, 'rule');
  assert.equal(config.proxies.length, 2);
  assert.deepEqual(config['proxy-groups'][0].proxies, ['Fixture Node', 'Second', 'DIRECT']);
  assert.deepEqual(config.rules, ['MATCH,节点选择']);
  const encoded = Buffer.from(lines).toString('base64');
  assert.equal(subscription.buildClashRuntimeConfigFromSubscription(encoded).proxies.length, 2);
  assert.equal(subscription.buildClashRuntimeConfigFromSubscription('not a subscription'), null);
});

test('runtime normalization accepts YAML, encoded subscriptions and reports invalid input', () => {
  const yaml = 'mixed-port: 7890\nproxies:\n  - name: A\n    type: direct\nrules: [MATCH,DIRECT]';
  const normalized = subscription.normalizeDirectClashRuntimeConfig(yaml, { coreDir: 'fixture' });
  assert.equal(normalized.ok, true);
  assert.equal(YAML.parse(normalized.content).mode, 'rule');
  assert.equal(normalized.compatibility.mode, 'rule');
  const encodedSubscription = Buffer.from(vmess()).toString('base64');
  assert.equal(subscription.normalizeDirectClashRuntimeConfig(encodedSubscription).ok, true);
  assert.match(subscription.normalizeDirectClashRuntimeConfig('').error, /空/);
  assert.match(subscription.normalizeDirectClashRuntimeConfig('not: [valid').error, /解析失败/);
});

test('runtime import purges stale configs and writes normalized config atomically', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-subscription-import-'));
  try {
    const imported = subscription.importDirectClashRuntimeConfig(root, {
      config: 'mixed-port: 7890\nproxies: []\nrules: [MATCH,DIRECT]',
    }, 'fixture');
    assert.equal(imported.ok, true);
    assert.equal(imported.source, 'fixture');
    assert.deepEqual(imported.purgeResult, { removed: ['old.yaml'] });
    assert.equal(imported.runtimeConfigPath, path.join(root, 'config.yaml'));
    assert.equal(fs.existsSync(imported.runtimeConfigPath), true);
    assert.match(imported.generatedPreview, /mixed-port/);
    assert.equal(subscription.importDirectClashRuntimeConfig(root, '', 'fixture').ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
