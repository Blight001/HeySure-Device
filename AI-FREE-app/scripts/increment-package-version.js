'use strict';

const fs = require('fs');
const path = require('path');

function incrementVersionText(source) {
  const pkg = JSON.parse(source);
  const currentVersion = String(pkg.version);
  const parts = currentVersion.split('.');

  if (parts.length !== 3 || parts.some((part) => !/^\d+$/.test(part))) {
    throw new Error('package.json version must use the x.y.z format required by electron-builder');
  }

  parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + 1);
  const nextVersion = parts.join('.');
  const versionPattern = /("version"\s*:\s*")([^"]+)(")/;

  if (!versionPattern.test(source)) {
    throw new Error('package.json does not contain a version field');
  }

  return {
    currentVersion,
    nextVersion,
    source: source.replace(versionPattern, `$1${nextVersion}$3`),
  };
}

function incrementPackageVersion(packagePath) {
  const source = fs.readFileSync(packagePath, 'utf8');
  const result = incrementVersionText(source);
  fs.writeFileSync(packagePath, result.source);
  return result;
}

if (require.main === module) {
  const packagePath = path.resolve(__dirname, '..', 'package.json');
  const result = incrementPackageVersion(packagePath);
  console.log(`[OK] Version bumped: ${result.currentVersion} -> ${result.nextVersion}`);
}

module.exports = { incrementPackageVersion, incrementVersionText };
