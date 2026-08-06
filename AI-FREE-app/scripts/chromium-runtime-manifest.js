'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const INTEGRITY_FILES = [
  'ai-free-browser.exe',
  'chrome.dll',
  'chrome_elf.dll',
  'icudtl.dat',
  'resources.pak',
];

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function writeChromiumRuntimeManifest(runtimeDir) {
  const root = path.resolve(runtimeDir);
  const files = {};
  for (const relativePath of INTEGRITY_FILES) {
    const filePath = path.join(root, relativePath);
    const stat = fs.statSync(filePath);
    files[relativePath.replace(/\\/g, '/')] = {
      size: stat.size,
      sha256: hashFile(filePath),
    };
  }
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    files,
  };
  const target = path.join(root, 'runtime-manifest.json');
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch (_) {}
    throw error;
  }
  return target;
}

if (require.main === module) {
  const runtimeDir = process.argv[2] || path.join(__dirname, '..', 'resources', 'chromium');
  console.log(`[chromium-manifest] ${writeChromiumRuntimeManifest(runtimeDir)}`);
}

module.exports = { INTEGRITY_FILES, writeChromiumRuntimeManifest };
