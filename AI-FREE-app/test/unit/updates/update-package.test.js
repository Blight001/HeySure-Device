'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const tar = require('tar');
const updatePackage = require('../../../src/app/main/features/updates/update-package');

test('update package filesystem helpers discover, copy and clean launch assets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-update-package-'));
  try {
    const source = path.join(root, 'source');
    const nested = path.join(source, 'nested');
    updatePackage.safeMkdir(nested);
    fs.writeFileSync(path.join(nested, 'AI-FREE.exe'), 'binary-fixture');
    fs.writeFileSync(path.join(source, 'readme.txt'), 'readme');

    assert.equal(updatePackage.isArchiveFile('release.TAR.GZ'), true);
    assert.equal(updatePackage.isArchiveFile('release.exe'), false);
    assert.equal(updatePackage.isExecutableCandidate('install.PS1'), true);
    assert.equal(updatePackage.isExecutableCandidate('readme.txt'), false);
    assert.equal(await updatePackage.findLaunchTarget(source, 'nested/AI-FREE.exe'), path.join(nested, 'AI-FREE.exe'));
    assert.equal(await updatePackage.findLaunchTarget(source), path.join(nested, 'AI-FREE.exe'));

    const copied = path.join(root, 'copied');
    updatePackage.copyDirectoryContents(source, copied);
    assert.equal(fs.readFileSync(path.join(copied, 'nested', 'AI-FREE.exe'), 'utf8'), 'binary-fixture');

    const archive = path.join(root, 'package.tar');
    await tar.c({ file: archive, cwd: source }, ['nested', 'readme.txt']);
    const extracted = path.join(root, 'extracted');
    await updatePackage.extractDownloadedPackage(archive, extracted, silentLogger());
    assert.equal(fs.readFileSync(path.join(extracted, 'nested', 'AI-FREE.exe'), 'utf8'), 'binary-fixture');
    assert.deepEqual(updatePackage.cleanupDownloadedArchive(archive, silentLogger()).removed, true);
    assert.deepEqual(updatePackage.cleanupDownloadedArchive(archive, silentLogger()).removed, false);
    assert.deepEqual(updatePackage.cleanupDownloadedArchive(path.join(root, 'plain.txt'), silentLogger()).removed, false);

    const cleanupTarget = path.join(root, 'cache');
    updatePackage.safeMkdir(cleanupTarget);
    fs.writeFileSync(path.join(cleanupTarget, 'stale.bin'), 'stale');
    const cleanup = updatePackage.cleanupUpdateStorageRoot(cleanupTarget, silentLogger());
    assert.equal(cleanup.ok, true);
    assert.equal(cleanup.results[0].removed, true);
    updatePackage.clearDirectory(copied);
    assert.equal(fs.existsSync(copied), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('downloadFile follows redirects, reports progress and rejects HTTP failures', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-update-download-'));
  const payload = Buffer.from('download-payload');
  const server = http.createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: '/file' });
      response.end();
      return;
    }
    if (request.url === '/file') {
      response.writeHead(200, { 'Content-Length': payload.length });
      response.end(payload);
      return;
    }
    response.writeHead(503);
    response.end('unavailable');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const destination = path.join(root, 'downloads', 'release.bin');
    const progress = [];
    const result = await updatePackage.downloadFile(
      `http://127.0.0.1:${port}/redirect`,
      destination,
      (event) => progress.push(event),
    );
    assert.equal(result.destination, destination);
    assert.equal(result.totalBytes, payload.length);
    assert.deepEqual(fs.readFileSync(destination), payload);
    assert.equal(progress.at(-1).receivedBytes, payload.length);
    assert.equal(progress.at(-1).percent, 99.5);
    await assert.rejects(
      updatePackage.downloadFile(`http://127.0.0.1:${port}/missing`, path.join(root, 'missing.bin')),
      /HTTP 状态码 503/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('storage roots are deterministic and empty launch targets are rejected', async () => {
  const fakePath = { resolve: (...parts) => parts.join('|') };
  assert.equal(
    updatePackage.getUpdateStorageRoot(fakePath, { getPath: () => 'user-data' }),
    'user-data|ai-free-update',
  );
  assert.match(updatePackage.getLegacyUpdateStorageRoot(), /src[\\/]assets[\\/]ai-free-update$/);
  await assert.rejects(updatePackage.launchExecutable(''), /启动目标为空/);
});

function silentLogger() {
  return { error() {}, warn() {} };
}
