const fs = require('fs');
const path = require('path');

const ICON_FILE_NAME = 'logo.ico';
const DEV_ICON_PATH = path.resolve(__dirname, '../../../../src/assets/logo.ico');
const PACKAGED_ICON_PATH = path.join('resource', ICON_FILE_NAME);

// 获取/读取/解析：resolveAppIconPath的具体业务逻辑。
function resolveAppIconPath() {
  const candidates = [];

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, PACKAGED_ICON_PATH));
  }

  candidates.push(DEV_ICON_PATH);

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar', 'src', 'assets', ICON_FILE_NAME));
  }

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    } catch (_) {}
  }

  return candidates[0] || DEV_ICON_PATH;
}

module.exports = {
  resolveAppIconPath,
};
