'use strict';

const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');
const { packagedExtensions = [] } = require('../platforms-config.json');

const SKIPPED_DIRS = new Set(['node_modules', 'vendor']);
const EXECUTE_SCRIPT_PATTERN = /chrome\s*\.\s*scripting\s*\.\s*executeScript\s*\(/;

// chrome.scripting.executeScript({ func }) serializes func and evaluates it in the
// target page. String-array obfuscation may make that function reference a decoder
// in the extension worker's outer scope, which does not exist in the page context.
// Keep identifier obfuscation for these files, but leave their strings inline so
// every serialized function remains self-contained.
function buildObfuscationOptions(source = '') {
  const containsSerializedPageFunction = String(source)
    .split(/\r?\n/)
    .some((line) => !/^\s*\/\//.test(line) && EXECUTE_SCRIPT_PATTERN.test(line));
  return {
    compact: true,
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false,
    selfDefending: false,
    stringArray: !containsSerializedPageFunction,
    stringArrayEncoding: containsSerializedPageFunction ? [] : ['base64'],
    stringArrayThreshold: 0.75,
    transformObjectKeys: false,
    unicodeEscapeSequence: false,
  };
}

function walkJavaScriptFiles(rootDir) {
  const files = [];
  const pending = [rootDir];

  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name.toLowerCase())) pending.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.js')) continue;
      if (entry.name.toLowerCase().endsWith('.min.js')) continue;
      files.push(fullPath);
    }
  }

  return files;
}

function resolveExtensionsRoot(appOutDir) {
  const resourcesDir = path.join(appOutDir, 'resources');
  const candidates = [
    path.join(resourcesDir, 'app.asar.unpacked', 'src', 'assets', 'extensions'),
    path.join(resourcesDir, 'app.asar.unpacked', 'assets', 'extensions'),
    path.join(resourcesDir, 'src', 'assets', 'extensions'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

exports.default = async function obfuscatePackagedExtensions(context) {
  const extensionsRoot = resolveExtensionsRoot(context.appOutDir);
  if (!extensionsRoot) {
    if (Array.isArray(packagedExtensions) && packagedExtensions.length === 0) {
      console.log('[extensions-protection] 未配置打包插件，跳过混淆');
      return;
    }
    throw new Error(`未找到打包后的 extensions 目录: ${context.appOutDir}`);
  }

  const files = walkJavaScriptFiles(extensionsRoot);
  console.log(`[extensions-protection] 开始混淆 ${files.length} 个 JavaScript 文件`);

  for (const filePath of files) {
    const source = fs.readFileSync(filePath, 'utf8');
    if (!source.trim()) continue;

    const result = JavaScriptObfuscator.obfuscate(source, /** @type {any} */ (buildObfuscationOptions(source)));
    fs.writeFileSync(filePath, result.getObfuscatedCode(), 'utf8');
  }

  console.log(`[extensions-protection] 插件 JavaScript 混淆完成: ${extensionsRoot}`);
};

exports.buildObfuscationOptions = buildObfuscationOptions;
