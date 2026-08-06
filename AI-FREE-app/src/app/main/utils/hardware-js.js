// 简化稳定方案：deviceId = SHA256(machineId original)
// 依赖：node-machine-id

const crypto = require('crypto');
const os = require('os');
const { machineIdSync, machineId } = require('node-machine-id');

// 获取/读取/解析：getHardwareFingerprint的具体业务逻辑。
/**
 * @param {{machineIdSync?: Function, machineId?: Function}} [dependencies]
 */
async function getHardwareFingerprint(dependencies = {}) {
  const readMachineIdSync = dependencies.machineIdSync || machineIdSync;
  const readMachineId = dependencies.machineId || machineId;
  try {
    let mid = '';
    try {
      mid = readMachineIdSync({ original: true });
    } catch (_) {
      // ignore
    }
    if (!mid) {
      mid = await readMachineId({ original: true });
    }
    if (!mid) throw new Error('machineId unavailable');
    // 输出为小写十六进制（与 Python hashlib.hexdigest 风格一致）
    return crypto.createHash('sha256').update(mid, 'utf8').digest('hex');
  } catch (e) {
    // 极端兜底（理论上很少触发）
    const seed = [os.hostname(), process.platform, process.arch].filter(Boolean).join('|');
    return crypto.createHash('sha256').update('fallback|' + seed, 'utf8').digest('hex');
  }
}

module.exports = { getHardwareFingerprint };

