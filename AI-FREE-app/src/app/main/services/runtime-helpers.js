function rememberLoadedTranslateExtension(session, extension, logger, label, message) {
  try { session.__translateExtId = extension?.id; } catch (_) {}
  logger.log?.(message, label ? `(${label})` : '', extension?.name, extension?.id);
}

function findLoadedExtension(session) {
  const all = session.getAllExtensions ? session.getAllExtensions() : null;
  return all ? Object.values(all)[0] : null;
}

async function loadTranslateExtensionIntoSession(session, label, extDir, logger) {
  if (!session?.extensions?.loadExtension) return;
  try {
    const extension = await session.extensions.loadExtension(extDir, { allowFileAccess: true });
    rememberLoadedTranslateExtension(session, extension, logger, label, '[TranslateExt] 扩展已加载');
  } catch (error) {
    const message = error?.message || String(error);
    if (/already loaded|exists/i.test(message)) {
      try {
        const extension = findLoadedExtension(session);
        if (extension) {
          rememberLoadedTranslateExtension(session, extension, logger, label, '[TranslateExt] 会话中已存在扩展');
          return;
        }
      } catch (readError) {
        logger.warn?.('[TranslateExt] 读取已加载扩展失败:', readError?.message || readError);
      }
    }
    logger.warn?.('[TranslateExt] 扩展加载失败', label ? `(${label})` : '', message);
  }
}

function createRuntimeHelpers(deps = {}) {
  const {
    app,
    fs,
    path,
    logger = console,
    getHardwareFingerprint,
    getTranslateExtDirCandidates,
  } = deps;

// 获取/读取/解析：resolveTranslateExtCandidates的具体业务逻辑。
  function resolveTranslateExtCandidates() {
    const candidates = [];

    // 打包后优先找解包资源目录，避免指向 app.asar 内部导致 loadExtension 失败。
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'assets', 'extensions', 'transform'));
      candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'extensions', 'transform'));
      candidates.push(path.join(process.resourcesPath, 'src', 'assets', 'extensions', 'transform'));
    }

    if (app && typeof app.getAppPath === 'function') {
      const appPath = app.getAppPath();
      candidates.push(path.join(appPath, 'src', 'assets', 'extensions', 'transform'));
      candidates.push(path.join(appPath, 'assets', 'extensions', 'transform'));
    }

    candidates.push(path.join(__dirname, '../../../assets/extensions/transform'));

    const seen = new Set();
    return candidates.filter((candidate) => {
      const normalized = path.normalize(candidate);
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
  }

// 获取/读取/解析：getTranslateExtDir的具体业务逻辑。
  function getTranslateExtDir() {
    const candidates = typeof getTranslateExtDirCandidates === 'function'
      ? getTranslateExtDirCandidates()
      : resolveTranslateExtCandidates();
    for (const dir of candidates) {
      try {
        if (dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
      } catch (_) {}
    }
    // transform 是可选的内置插件。用户从源码或打包配置中移除它时，
    // 用空值表示“未安装”，避免把正常的缺失状态当作启动错误反复打印。
    return '';
  }

  async function loadTranslateExtension(session, label = '') {
    const extDir = getTranslateExtDir();
    if (!extDir) return null;
    return loadTranslateExtensionIntoSession(session, label, extDir, logger);
  }

// 处理：computeDeviceId的具体业务逻辑。
  async function computeDeviceId() {
    try {
      const fingerprint = await getHardwareFingerprint();
      return fingerprint.slice(0, 20).toUpperCase();
    } catch (e) {
      logger.error?.('获取设备号失败:', e);
      return '获取失败';
    }
  }

  return {
    getTranslateExtDir,
    loadTranslateExtension,
    computeDeviceId,
  };
}

module.exports = {
  createRuntimeHelpers,
};
