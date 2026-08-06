'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-assets-module-'));
const appData = path.join(root, 'app-data');
const resources = path.join(root, 'resources');
const legacyCore = path.join(root, 'legacy-core');
const electronPath = require.resolve('electron');
const configPath = require.resolve('../../../src/app/main/config');
const targetPath = require.resolve('../../../src/app/main/features/network/clash-mini-assets');
require.cache[electronPath] = { exports: { app: { getPath: () => appData } } };
require.cache[configPath] = { exports: { getCoreDir: () => legacyCore } };
Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resources });
delete require.cache[targetPath];
const assets = require(targetPath);

function makeSource(base) {
  const core = path.join(base, 'clash-mini', 'core');
  fs.mkdirSync(path.join(core, 'providers'), { recursive: true });
  fs.writeFileSync(path.join(core, 'verge-mihomo.exe'), 'binary');
  for (const relative of assets.getLocalAssetRelativePaths()) {
    const file = path.join(core, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `fixture:${relative}`);
  }
  return core;
}

test.after(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('recursive copy helpers preserve existing files unless overwrite is requested', async () => {
  const source = path.join(root, 'copy-source');
  const destination = path.join(root, 'copy-destination');
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(source, 'a.txt'), 'new');
  fs.writeFileSync(path.join(source, 'nested', 'b.txt'), 'nested');
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, 'a.txt'), 'old');
  assert.equal(assets.copyDirectoryRecursive('', destination), false);
  assert.equal(assets.copyDirectoryRecursive(source, destination), true);
  assert.equal(fs.readFileSync(path.join(destination, 'a.txt'), 'utf8'), 'old');
  assets.copyDirectoryRecursive(source, destination, { overwrite: true });
  assert.equal(fs.readFileSync(path.join(destination, 'a.txt'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(destination, 'nested', 'b.txt'), 'utf8'), 'nested');

  const asyncDestination = path.join(root, 'copy-async');
  assert.equal(await assets.copyDirectoryRecursiveAsync(path.join(root, 'missing'), asyncDestination), false);
  assert.equal(await assets.copyDirectoryRecursiveAsync(source, asyncDestination), true);
  fs.writeFileSync(path.join(asyncDestination, 'a.txt'), 'kept');
  await assets.copyDirectoryRecursiveAsync(source, asyncDestination);
  assert.equal(fs.readFileSync(path.join(asyncDestination, 'a.txt'), 'utf8'), 'kept');
  await assets.copyDirectoryRecursiveAsync(source, asyncDestination, { overwrite: true });
  assert.equal(fs.readFileSync(path.join(asyncDestination, 'a.txt'), 'utf8'), 'new');
});

test('root, executable and manifest helpers describe bundled assets', async () => {
  const bundledCore = makeSource(resources);
  assert.ok(assets.getClashMiniAppRoots().some((item) => item === path.join(resources, 'clash-mini')));
  assert.ok(assets.getClashMiniCoreRoots().includes(bundledCore));
  assert.ok(assets.getClashMiniProfileRoots().includes(path.join(appData, 'clash-mini')));
  assert.equal(assets.resolveBundledClashMiniCoreDir(), bundledCore);
  assert.equal(assets.resolveClashMiniExecutable(bundledCore), path.join(bundledCore, 'verge-mihomo.exe'));
  assert.equal(assets.resolveClashMiniExecutable(path.join(root, 'missing')), null);
  const manifest = assets.buildLocalAssetManifest(bundledCore);
  assert.equal(manifest.files.length, assets.getLocalAssetRelativePaths().length);
  assert.ok(manifest.signature.includes('geoip.metadb'));
  const markerDir = path.join(root, 'marker');
  fs.mkdirSync(markerDir);
  assets.writeLocalAssetMarker(markerDir, manifest);
  assert.deepEqual(assets.readLocalAssetMarker(markerDir), manifest);
  assert.equal(assets.isLocalAssetSizeCurrent(markerDir, manifest.files[0]), false);
  await assets.writeLocalAssetMarkerAsync(markerDir, { signature: 'async' });
  assert.equal(assets.readLocalAssetMarker(markerDir).signature, 'async');
  assert.equal(assets.readLocalAssetMarker(path.join(root, 'missing')), null);
});

test('sync copies complete asset sets, then skips files matching the marker', async () => {
  makeSource(resources);
  const runtime = path.join(root, 'runtime-sync');
  const first = assets.syncLocalGeoAssets(runtime);
  assert.equal(first.ok, true);
  assert.equal(first.copied.length, assets.getLocalAssetRelativePaths().length);
  const second = assets.syncLocalGeoAssets(runtime);
  assert.equal(second.ok, true);
  assert.equal(second.skipped.length, assets.getLocalAssetRelativePaths().length);
  fs.unlinkSync(path.join(runtime, 'geoip.metadb'));
  const repaired = await assets.syncLocalGeoAssetsAsync(runtime);
  assert.equal(repaired.ok, true);
  assert.ok(repaired.copied.includes('geoip.metadb'));
});

test('runtime preparation copies the core once and config purge reports removals', async () => {
  makeSource(resources);
  const first = await assets.prepareClashMiniRuntimeDirAsync();
  assert.equal(first.ok, true);
  assert.equal(first.runtimeDir, path.join(appData, 'clash-mini'));
  assert.equal(fs.existsSync(first.exePath), true);
  const second = await assets.prepareClashMiniRuntimeDirAsync();
  assert.equal(second.cached, true);
  for (const name of ['config.yaml', 'self.yaml', 'profiles.yaml']) fs.writeFileSync(path.join(first.runtimeDir, name), 'fixture');
  const purge = assets.purgeClashMiniRuntimeConfigFiles(first.runtimeDir);
  assert.deepEqual(purge.removed.sort(), ['config.yaml', 'profiles.yaml', 'self.yaml']);
  assert.equal(purge.ok, true);
});
