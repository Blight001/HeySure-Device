'use strict';

const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectDir = path.resolve(__dirname, '..');
const sourceRoot = path.join(projectDir, 'src');
const buildRoot = path.join(projectDir, '.generated', 'app');

function assertBuildRoot(target) {
  const expected = path.join(projectDir, '.generated', 'app');
  if (path.resolve(target) !== expected) throw new Error(`拒绝写入非预期源码构建目录: ${target}`);
}

function moduleKindFor(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  return /^(?:app\/renderer|app\/sidebar)\//.test(normalized)
    ? 'esmodule'
    : 'commonjs';
}

function listFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  };
  visit(root);
  return files;
}

function outputRelativePath(relativePath) {
  return relativePath.replace(/\.(?:ts|tsx)$/i, '.js');
}

function compileFile(filePath, outputRoot) {
  const relativePath = path.relative(sourceRoot, filePath);
  const outputPath = path.join(outputRoot, 'src', outputRelativePath(relativePath));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (/\.(?:ts|tsx)$/i.test(relativePath) && !/(?:^|[\\/])assets[\\/]/.test(relativePath)) {
    return { copied: 0, compiled: 0, pendingTypeScript: 1, relativePath };
  }
  if (!/\.(?:js|cjs|mjs)$/i.test(relativePath) || /(?:^|[\\/])assets[\\/]/.test(relativePath)) {
    fs.copyFileSync(filePath, outputPath);
    return { copied: 1, compiled: 0, pendingTypeScript: 0, relativePath };
  }
  // 现有 JS 保持字节级兼容；新增 TS 由下方两个显式项目按进程边界编译。
  fs.copyFileSync(filePath, outputPath);
  return { copied: 0, compiled: 1, pendingTypeScript: 0, relativePath };
}

function compileTypeScriptProjects(pendingCount) {
  if (!pendingCount) return;
  const compiler = path.join(projectDir, 'node_modules', 'typescript', 'bin', 'tsc');
  const projects = [
    { config: 'tsconfig.build-main.json', roots: ['main', 'preload', 'contracts', 'shared'] },
    { config: 'tsconfig.build-renderer.json', roots: ['renderer', 'sidebar'] },
  ];
  for (const { config, roots } of projects) {
    const hasInput = roots.some((root) => {
      const sourceDirectory = path.join(sourceRoot, 'app', root);
      return fs.existsSync(sourceDirectory)
        && listFiles(sourceDirectory).some((filePath) => /\.tsx?$/i.test(filePath));
    });
    if (!hasInput) continue;
    const result = spawnSync(process.execPath, [compiler, '-p', config], {
      cwd: projectDir,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) throw new Error(`TypeScript 构建失败 (${config})\n${result.stdout || ''}${result.stderr || ''}`);
  }
}

function writeRuntimeFiles(outputRoot) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
  const runtimePackage = {
    name: packageJson.name,
    version: packageJson.version,
    private: true,
    main: packageJson.main,
  };
  fs.writeFileSync(path.join(outputRoot, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`, 'utf8');
  for (const name of ['platforms-config.json']) {
    const source = path.join(projectDir, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(outputRoot, name));
  }
}

function stampExtensionServiceWorkers(outputRoot) {
  const extensionsRoot = path.join(sourceRoot, 'assets', 'extensions');
  if (!fs.existsSync(extensionsRoot)) return [];
  const stamps = [];
  for (const entry of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const extensionRoot = path.join(extensionsRoot, entry.name);
    const manifestPath = path.join(extensionRoot, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    const extensionManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const serviceWorker = extensionManifest?.background?.service_worker;
    if (!serviceWorker) continue;
    const sourceWorkerPath = path.join(extensionRoot, serviceWorker);
    const outputWorkerPath = path.join(
      outputRoot, 'src', 'assets', 'extensions', entry.name, serviceWorker,
    );
    if (!fs.existsSync(sourceWorkerPath) || !fs.existsSync(outputWorkerPath)) continue;
    const extensionHash = crypto.createHash('sha256');
    for (const filePath of listFiles(extensionRoot).sort()) {
      extensionHash.update(path.relative(extensionRoot, filePath)).update(fs.readFileSync(filePath));
    }
    const digest = extensionHash.digest('hex');
    const workerSource = fs.readFileSync(outputWorkerPath, 'utf8');
    const cacheBustedSource = workerSource.replace(
      /(['"])([^'"\r\n]+\.js)\1/g,
      (_match, quote, scriptPath) => `${quote}${scriptPath}?v=${digest}${quote}`,
    );
    const parsedWorkerPath = path.parse(serviceWorker);
    const generatedServiceWorker = path.join(
      parsedWorkerPath.dir,
      `${parsedWorkerPath.name}.${digest}${parsedWorkerPath.ext}`,
    ).replace(/\\/g, '/');
    const generatedWorkerPath = path.join(
      outputRoot, 'src', 'assets', 'extensions', entry.name, generatedServiceWorker,
    );
    const stampedWorker = `${cacheBustedSource}\n// build-source-extension-hash:${digest}\n`;
    fs.writeFileSync(
      outputWorkerPath,
      stampedWorker,
      'utf8',
    );
    fs.writeFileSync(generatedWorkerPath, stampedWorker, 'utf8');
    const outputManifestPath = path.join(
      outputRoot, 'src', 'assets', 'extensions', entry.name, 'manifest.json',
    );
    const outputManifest = JSON.parse(fs.readFileSync(outputManifestPath, 'utf8'));
    outputManifest.background.service_worker = generatedServiceWorker;
    fs.writeFileSync(outputManifestPath, `${JSON.stringify(outputManifest, null, 2)}\n`, 'utf8');
    stamps.push({
      extension: entry.name,
      serviceWorker,
      generatedServiceWorker,
      hash: digest,
    });
  }
  return stamps;
}

function buildSource() {
  assertBuildRoot(buildRoot);
  fs.rmSync(buildRoot, { recursive: true, force: true });
  fs.mkdirSync(buildRoot, { recursive: true });
  const totals = { compiled: 0, copied: 0, pendingTypeScript: 0 };
  const hash = crypto.createHash('sha256');
  for (const filePath of listFiles(sourceRoot)) {
    const result = compileFile(filePath, buildRoot);
    totals.compiled += result.compiled;
    totals.copied += result.copied;
    totals.pendingTypeScript += result.pendingTypeScript;
    hash.update(result.relativePath).update(fs.readFileSync(filePath));
  }
  compileTypeScriptProjects(totals.pendingTypeScript);
  const extensionServiceWorkers = stampExtensionServiceWorkers(buildRoot);
  writeRuntimeFiles(buildRoot);
  const manifest = {
    version: 1,
    sourceHash: hash.digest('hex'),
    compiledFiles: totals.compiled,
    copiedFiles: totals.copied,
    mainFormat: 'commonjs',
    rendererFormat: 'esmodule',
    extensionServiceWorkers,
  };
  fs.writeFileSync(path.join(buildRoot, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  if (!fs.existsSync(path.join(buildRoot, 'src', 'app', 'main', 'main.js'))) {
    throw new Error('源码构建缺少主进程入口 src/app/main/main.js');
  }
  return manifest;
}

if (require.main === module) {
  const manifest = buildSource();
  console.log(`[build:source] 完成：${manifest.compiledFiles} 个脚本，${manifest.copiedFiles} 个资源，${manifest.sourceHash.slice(0, 12)}`);
}

module.exports = {
  buildRoot,
  buildSource,
  compileTypeScriptProjects,
  moduleKindFor,
  stampExtensionServiceWorkers,
};
