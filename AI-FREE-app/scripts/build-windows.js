const fs = require('fs');
const path = require('path');
const { build, Platform } = require('electron-builder');
const { verifyPackagedRuntime } = require('./verify-packaged-runtime');
const { writeChromiumRuntimeManifest } = require('./chromium-runtime-manifest');
const { buildNativeHost } = require('./build-native-host');
const { buildSource } = require('./build-source');

const projectDir = path.resolve(__dirname, '..');
const extensionsDir = path.join(projectDir, 'src', 'assets', 'extensions');
const configPath = path.join(projectDir, 'platforms-config.json');
const packagePath = path.join(projectDir, 'package.json');
const alwaysPackagedExtensions = new Set(['clash-mini']);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isTransientFileLock(error) {
  const code = error && error.code;
  const message = String(error && error.message ? error.message : error);
  return code === 'EBUSY' || code === 'EPERM' || /\b(?:EBUSY|EPERM)\b/.test(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {any} options @param {string} label @param {{beforeRetry?: Function}} [hooks] */
async function buildWithRetry(options, label, { beforeRetry } = {}) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await build(options);
      return;
    } catch (error) {
      if (!isTransientFileLock(error) || attempt === maxAttempts) {
        if (isTransientFileLock(error)) {
          error.message = `${error.message}\n${label}连续 ${maxAttempts} 次遇到文件占用。请完全退出正在运行的 AI-FREE 后重试；不要直接结束其他 Clash 软件的进程。`;
        }
        throw error;
      }

      console.warn(`[build:win] ${label}遇到临时文件占用，等待 5 秒后进行第 ${attempt}/${maxAttempts - 1} 次重试...`);
      await delay(5000);
      if (typeof beforeRetry === 'function') {
        await beforeRetry();
      }
    }
  }
}

function isChromiumExtraResource(entry) {
  return entry
    && String(entry.from || '').replace(/\\/g, '/') === 'resources/chromium';
}

function isClashCoreExtraResource(entry) {
  return entry
    && String(entry.from || '').replace(/\\/g, '/') === 'resources/clash-mini/core';
}

function isDeferredExtraResource(entry) {
  return isChromiumExtraResource(entry) || isClashCoreExtraResource(entry);
}

function assertExpectedAppOutput(appOutDir) {
  const resolvedOutput = path.resolve(appOutDir);
  const resolvedBuildRoot = path.resolve(projectDir, 'appbuild');
  if (resolvedOutput !== path.join(resolvedBuildRoot, 'win-unpacked')) {
    throw new Error(`拒绝操作非预期构建目录: ${resolvedOutput}`);
  }
}

function writeStageConfigFile(appOutDir, stageConfig) {
  assertExpectedAppOutput(appOutDir);
  const outputDir = path.dirname(appOutDir);
  const configPath = path.join(outputDir, '.electron-builder-stage.json');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(stageConfig, null, 2)}\n`, 'utf8');
  return configPath;
}

function resolveDeferredResourceSpec(appOutDir, entry, options) {
  const sourceEntry = entry || {};
  const label = String(options.label || sourceEntry.to || sourceEntry.from || '延后资源');
  const requiredFile = String(options.requiredFile || '').trim();
  const sourceDir = path.resolve(projectDir, String(sourceEntry.from || ''));
  const resourcesDir = path.resolve(appOutDir, 'resources');
  const targetDir = path.resolve(resourcesDir, String(sourceEntry.to || path.basename(sourceDir)));
  return { label, requiredFile, sourceDir, resourcesDir, targetDir };
}

function validateDeferredResourceSpec(spec) {
  const relativeTarget = path.relative(spec.resourcesDir, spec.targetDir);
  if (!relativeTarget || relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
    throw new Error(`拒绝同步 ${spec.label} 到 resources 之外: ${spec.targetDir}`);
  }
  const requiredPath = spec.requiredFile && path.join(spec.sourceDir, spec.requiredFile);
  if (!fs.existsSync(spec.sourceDir) || (requiredPath && !fs.existsSync(requiredPath))) {
    throw new Error(`未找到内置 ${spec.label}: ${spec.sourceDir}`);
  }
}

function copyDeferredResource(spec) {
  fs.rmSync(spec.targetDir, { recursive: true, force: true });
  fs.cpSync(spec.sourceDir, spec.targetDir, { recursive: true, force: true });
  console.log(`[build:win] ${spec.label} 已独立同步到: ${spec.targetDir}`);
}

async function syncDeferredExtraResource(appOutDir, entry, options = {}) {
  assertExpectedAppOutput(appOutDir);

  const spec = resolveDeferredResourceSpec(appOutDir, entry, options);
  validateDeferredResourceSpec(spec);

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      copyDeferredResource(spec);
      return;
    } catch (error) {
      if (!isTransientFileLock(error) || attempt === maxAttempts) {
        if (isTransientFileLock(error)) {
          error.message = `${error.message}\n${spec.label} 连续 ${maxAttempts} 次遇到文件占用。请稍后重试，并确认未运行 appbuild 中的 AI-FREE。`;
        }
        throw error;
      }
      console.warn(`[build:win] ${spec.label} 同步遇到临时文件占用，等待 2 秒后重试 (${attempt}/${maxAttempts - 1})...`);
      await delay(2000);
    }
  }
}

function cleanAppOutput(appOutDir) {
  const resolvedOutput = path.resolve(appOutDir);
  const expectedOutput = path.resolve(projectDir, 'appbuild', 'win-unpacked');
  if (resolvedOutput !== expectedOutput) {
    throw new Error(`拒绝清理非预期构建目录: ${resolvedOutput}`);
  }
  fs.rmSync(resolvedOutput, { recursive: true, force: true });
}

async function cleanAppOutputForRetry(appOutDir) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      cleanAppOutput(appOutDir);
      return;
    } catch (error) {
      if (!isTransientFileLock(error) || attempt === maxAttempts) throw error;
      console.warn(`[build:win] 半成品目录仍被占用，等待 2 秒后再次清理 (${attempt}/${maxAttempts - 1})...`);
      await delay(2000);
    }
  }
}

function resolvePackagedExtensions() {
  const appConfig = readJson(configPath);
  const configured = appConfig.packagedExtensions;

  if (!Array.isArray(configured)) {
    throw new Error(`packagedExtensions 必须在 ${configPath} 中配置为字符串数组`);
  }

  const available = fs.readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const selectable = available.filter((name) => !alwaysPackagedExtensions.has(name));
  const selected = new Set();

  for (const name of configured) {
    if (typeof name !== 'string' || !name || path.basename(name) !== name) {
      throw new Error(`packagedExtensions 中包含无效插件名称: ${JSON.stringify(name)}`);
    }
    if (alwaysPackagedExtensions.has(name)) {
      throw new Error(`${name} 无需配置，它始终会被打包`);
    }
    if (!selectable.includes(name)) {
      throw new Error(`packagedExtensions 中的插件不存在: ${name}`);
    }
    if (!selected.add(name)) {
      throw new Error(`packagedExtensions 中存在重复插件: ${name}`);
    }
  }

  return {
    selected: [...selected],
    excluded: selectable.filter((name) => !selected.has(name)),
  };
}

async function main() {
  writeChromiumRuntimeManifest(path.join(projectDir, 'resources', 'chromium'));
  buildSource();
  const packageJson = readJson(packagePath);
  const builderConfig = packageJson.build || {};
  const { selected, excluded } = resolvePackagedExtensions();
  const configuredFiles = Array.isArray(builderConfig.files) ? builderConfig.files : [];

  const mappedFiles = configuredFiles.map((entry) => appendGeneratedExtensionExclusions(entry, excluded));
  builderConfig.files = [
    ...mappedFiles,
    ...excluded.map((name) => `!src/assets/extensions/${name}/**/*`),
  ];

  console.log(`[extensions] 本次配置打包: ${selected.join(', ') || '(无)'}`);
  console.log('[extensions] clash-mini 始终打包');
  if (excluded.length) {
    console.log(`[extensions] 本次排除: ${excluded.join(', ')}`);
  }

  const outputDir = path.resolve(projectDir, builderConfig.directories?.output || 'dist');
  const appOutDir = path.join(outputDir, 'win-unpacked');
  const extraResources = Array.isArray(builderConfig.extraResources)
    ? builderConfig.extraResources
    : [];
  const chromiumResource = extraResources.find(isChromiumExtraResource);
  const clashCoreResource = extraResources.find(isClashCoreExtraResource);
  if (!chromiumResource) {
    throw new Error('build.extraResources 缺少 resources/chromium');
  }
  if (!clashCoreResource) {
    throw new Error('build.extraResources 缺少 resources/clash-mini/core');
  }

  if (process.argv.includes('--check')) {
    console.log('[build:win] 延后资源配置校验通过: Chromium, Clash Mini Core');
    return;
  }

  // 禁止把工作区中的旧 .node 产物直接带入安装包。
  // Electron ABI 目标和 CRT 链接方式都由当前源码在本次打包中重建。
  buildNativeHost();

  // Chromium 和 Clash Core 都包含会触发签名/实时扫描的可执行文件。若交给
  // electron-builder 与其它资源并行复制，Windows 偶发返回 EBUSY/EPERM。
  // 先生成主程序，再串行同步这两项资源，最后由预打包目录生成 NSIS。
  const stageConfig = {
    ...builderConfig,
    extraResources: extraResources.filter((entry) => !isDeferredExtraResource(entry)),
  };
  // electron-builder 会把 API 对象中的数组与 package.json 数组追加合并，直接把
  // stageConfig 作为 options.config 传入无法真正删除原 extraResources。显式配置
  // 文件会替代 package.json 的 build 字段，确保延后资源只在串行阶段复制一次。
  cleanAppOutput(appOutDir);
  const stageConfigPath = writeStageConfigFile(appOutDir, stageConfig);
  const stageOptions = {
    projectDir,
    targets: Platform.WINDOWS.createTarget('dir'),
    config: stageConfigPath,
  };

  try {
    await buildWithRetry(stageOptions, '应用预打包阶段', {
      // 首次失败会留下半成品。重试前清掉它，避免刚生成的 exe 被扫描器
      // 短暂占用后，下一轮继续复制到同一个目标文件而再次触发 EBUSY。
      beforeRetry: () => cleanAppOutputForRetry(appOutDir),
    });
  } finally {
    fs.rmSync(stageConfigPath, { force: true });
  }
  await syncDeferredExtraResource(appOutDir, clashCoreResource, {
    label: 'Clash Mini Core',
    requiredFile: 'verge-mihomo.exe',
  });
  await syncDeferredExtraResource(appOutDir, chromiumResource, {
    label: 'Chromium',
    requiredFile: 'ai-free-browser.exe',
  });
  verifyPackagedRuntime({ projectDir, appOutDir });

  const installerOptions = {
    projectDir,
    targets: Platform.WINDOWS.createTarget('nsis'),
    config: builderConfig,
    prepackaged: appOutDir,
  };
  await buildWithRetry(installerOptions, 'NSIS 安装包阶段');
}

function appendGeneratedExtensionExclusions(entry, excluded) {
  const source = entry && typeof entry === 'object'
    ? String(entry.from || '').replace(/\\/g, '/')
    : '';
  if (source !== '.generated/app/src') return entry;
  const filter = Array.isArray(entry.filter) ? entry.filter : ['**/*'];
  return {
    ...entry,
    filter: [...filter, ...excluded.map((name) => `!assets/extensions/${name}/**/*`)],
  };
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[build:win] ${error && error.stack ? error.stack : error}`);
    process.exit(1);
  });
}

module.exports = {
  isChromiumExtraResource,
  isClashCoreExtraResource,
  isDeferredExtraResource,
  syncDeferredExtraResource,
  writeStageConfigFile,
};
