// 将高频或敏感的网络调试信息仅投递到独立调试窗口。
// 未创建调试窗口时仍保存在调试历史中；严禁回退 console.*。
const { appContext } = require('./app-context');

function writeDebugConsoleOnly(level, ...args) {
  try {
    const sink = appContext.getDebugConsoleWrite();
    if (typeof sink !== 'function') return false;
    sink(String(level || 'info'), args);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  writeDebugConsoleOnly,
};
