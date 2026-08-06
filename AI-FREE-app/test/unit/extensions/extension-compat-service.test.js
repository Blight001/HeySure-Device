'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createExtensionCompatService } = require('../../../src/app/main/features/extensions/extension-compat-service');

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else fs.copyFileSync(from, to);
  }
}

function createFixture(root, overrides = {}) {
  const cacheRoot = path.join(root, 'cache');
  const logs = [];
  const service = createExtensionCompatService({
    compatCacheSchema: '1',
    compatShimFile: '__compat.js',
    compatShimMarker: '__fixture_compat__',
    copyDirectoryRecursive: copyDirectory,
    fs,
    hashId: (value) => Buffer.from(String(value)).toString('hex').slice(0, 12),
    isPathInside: (parent, child) => path.resolve(child).startsWith(`${path.resolve(parent)}${path.sep}`),
    listExtensionTextFiles: (dir) => ({ files: fs.readdirSync(dir).filter((name) => /\.html?$/.test(name)).map((name) => path.join(dir, name)) }),
    logger: { log: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')) },
    normalizeAbsolutePath: (value) => value ? path.resolve(value) : '',
    path,
    readJsonFile: (file) => JSON.parse(fs.readFileSync(file, 'utf8')),
    resolveCompatCacheRoot: () => cacheRoot,
    sanitizeManifestPermissionsForElectron: (manifest) => ({
      manifest: structuredClone(manifest), removedPermissions: manifest.permissions || [],
    }),
    scanExtensionCompatNeeds: () => ({ needsCompatShim: true, latestMtimeMs: 1, fileCount: 3, requiredApiRoots: ['browser'] }),
    toSafeFileName: (value) => String(value).replace(/[^a-z0-9_-]/gi, '_'),
    ...overrides,
  });
  return { cacheRoot, logs, service };
}

function writeExtension(root, manifest, files = {}) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
}

test('compatible extensions bypass copying and invalid paths are ignored', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-compat-bypass-'));
  try {
    const source = path.join(root, 'source');
    writeExtension(source, { manifest_version: 3 });
    const fixture = createFixture(root, { scanExtensionCompatNeeds: () => ({ needsCompatShim: false }) });
    assert.equal(fixture.service.prepareCompatExtensionPath({ path: '' }), '');
    assert.equal(fixture.service.prepareCompatExtensionPath({ path: source }), source);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('service worker and HTML pages receive a cached compatibility shim once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-compat-worker-'));
  try {
    const source = path.join(root, 'source');
    writeExtension(source, {
      manifest_version: 3, version: '1', permissions: ['tabs'], background: { service_worker: 'worker.js' },
    }, {
      'worker.js': 'console.log("worker")',
      'page.html': '<html><head></head><body></body></html>',
      'popup.htm': '<script>run()</script>',
    });
    const fixture = createFixture(root);
    const prepared = fixture.service.prepareCompatExtensionPath({ id: 'fixture', name: 'Fixture', path: source, version: '1' });
    assert.notEqual(prepared, source);
    assert.match(fs.readFileSync(path.join(prepared, 'worker.js'), 'utf8'), /__fixture_compat__/);
    assert.match(fs.readFileSync(path.join(prepared, 'page.html'), 'utf8'), /__compat\.js/);
    assert.match(fs.readFileSync(path.join(prepared, 'popup.htm'), 'utf8'), /__compat\.js/);
    assert.equal(fixture.service.prepareCompatExtensionPath({ id: 'fixture', path: source, version: '1' }), prepared);
    assert.equal((fs.readFileSync(path.join(prepared, 'worker.js'), 'utf8').match(/__fixture_compat__/g) || []).length, 1);
    assert.ok(fixture.logs.some((line) => line.includes('不识别的权限')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('background script arrays are patched in the manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-compat-scripts-'));
  try {
    const source = path.join(root, 'source');
    writeExtension(source, { manifest_version: 2, background: { scripts: ['background.js'] } }, { 'background.js': 'run()' });
    const fixture = createFixture(root);
    const prepared = fixture.service.prepareCompatExtensionPath({ id: 'scripts', path: source });
    const manifest = JSON.parse(fs.readFileSync(path.join(prepared, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.background.scripts, ['__compat.js', 'background.js']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('background pages and plain HTML files receive relative shim tags', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-compat-page-'));
  try {
    const source = path.join(root, 'source');
    writeExtension(source, { manifest_version: 2, background: { page: 'background.html' } }, {
      'background.html': '<body>background</body>', 'plain.html': '<div>plain</div>',
    });
    const fixture = createFixture(root);
    const prepared = fixture.service.prepareCompatExtensionPath({ id: 'page', path: source });
    assert.match(fs.readFileSync(path.join(prepared, 'background.html'), 'utf8'), /^<script src="\.\/__compat\.js"><\/script>/);
    assert.match(fs.readFileSync(path.join(prepared, 'plain.html'), 'utf8'), /^<script src="\.\/__compat\.js"><\/script>/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('invalid manifests and unsafe cache failures fall back to source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-compat-fallback-'));
  try {
    const source = path.join(root, 'source');
    writeExtension(source, { manifest_version: 3 });
    const fixture = createFixture(root, { readJsonFile: () => null });
    assert.equal(fixture.service.prepareCompatExtensionPath({ id: 'bad', path: source }), source);
    assert.ok(fixture.logs.some((line) => line.includes('回退原目录')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('interrupted compatibility copy never publishes or leaves a partial directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-compat-atomic-'));
  try {
    const source = path.join(root, 'source');
    writeExtension(source, { manifest_version: 3, background: { service_worker: 'worker.js' } }, {
      'worker.js': 'run()',
    });
    const fixture = createFixture(root, {
      copyDirectoryRecursive: (_source, target) => {
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, 'partial.js'), 'partial');
        throw new Error('simulated interrupted compatibility copy');
      },
    });
    assert.equal(fixture.service.prepareCompatExtensionPath({ id: 'atomic', path: source }), source);
    assert.deepEqual(fs.existsSync(fixture.cacheRoot) ? fs.readdirSync(fixture.cacheRoot) : [], []);
    assert.ok(fixture.logs.some((line) => line.includes('simulated interrupted compatibility copy')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
