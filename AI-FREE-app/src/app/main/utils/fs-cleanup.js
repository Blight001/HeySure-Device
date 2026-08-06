function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reportRemoveFailure(logger, failureMessage, dirPath, error) {
  if (logger && typeof logger.warn === 'function') logger.warn(failureMessage, dirPath, error?.message || error);
}

async function removeDirectoryWithRetries(fs, dirPath, options = {}) {
  const {
    attempts = 3,
    delayMs = 200,
    logger = null,
    failureMessage = '删除目录失败:',
  } = options;

  if (!fs) return false;
  if (!dirPath) return false;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (fs.promises.rm) {
        await fs.promises.rm(dirPath, { recursive: true, force: true });
      } else {
        await fs.promises.rmdir(dirPath, { recursive: true });
      }
      return true;
    } catch (error) {
      if (attempt >= attempts) {
        reportRemoveFailure(logger, failureMessage, dirPath, error);
        return false;
      }
      await delay(delayMs);
    }
  }

  return false;
}

module.exports = {
  removeDirectoryWithRetries,
};
