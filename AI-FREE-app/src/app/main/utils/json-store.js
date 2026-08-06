const defaultFs = require('fs');
const defaultPath = require('path');

function warn(logger, logPrefix, message, ...args) {
  if (!logger || typeof logger.warn !== 'function') return;
  logger.warn(`[${logPrefix}] ${message}`, ...args);
}

function readJsonFileSafe(filePath, options = {}) {
  const fs = options.fs || defaultFs;
  const fallback = Object.prototype.hasOwnProperty.call(options, 'fallback') ? options.fallback : {};
  const logPrefix = options.logPrefix || 'Store';
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8') || '{}');
  } catch (error) {
    warn(options.logger, logPrefix, options.readErrorMessage || '读取 JSON 失败:', filePath, error?.message || error);
    return fallback;
  }
}

function writeJsonFileSafe(filePath, data, options = {}) {
  const fs = options.fs || defaultFs;
  const path = options.path || defaultPath;
  const logPrefix = options.logPrefix || 'Store';
  try {
    if (!filePath) return false;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data || {}, null, 2), 'utf8');
    return true;
  } catch (error) {
    warn(options.logger, logPrefix, options.writeErrorMessage || '写入 JSON 失败:', error?.message || error);
    return false;
  }
}

function resolveStorePath(getStorePath) {
  return typeof getStorePath === 'function' ? getStorePath() : String(getStorePath || '');
}

function readStoreConfigFile(getStorePath, options = {}) {
  return readJsonFileSafe(resolveStorePath(getStorePath), {
    ...options,
    fallback: Object.prototype.hasOwnProperty.call(options, 'fallback') ? options.fallback : {},
    readErrorMessage: options.readErrorMessage || '读取 store 失败:',
  });
}

function writeStoreConfigFile(getStorePath, storeConfig, options = {}) {
  return writeJsonFileSafe(resolveStorePath(getStorePath), storeConfig, {
    ...options,
    writeErrorMessage: options.writeErrorMessage || '写入 store 失败:',
  });
}

module.exports = {
  readJsonFileSafe,
  writeJsonFileSafe,
  readStoreConfigFile,
  writeStoreConfigFile,
};
