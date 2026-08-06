// 结构化日志（阶段 2D，方案 §3.3）：统一字段
//   domain / operation / correlationId / profileId / channel / errorCode
// 输出为「[domain] operation {json}」单行，底层复用现有 logger（console 兼容）。
// 新代码使用本模块；存量 console.* 调用在各域整改时迁移。
// 脱敏责任在调用方：API Key、Cookie、卡密、凭证严禁进入 fields。
'use strict';

const KNOWN_FIELDS = ['operation', 'correlationId', 'profileId', 'channel', 'errorCode'];

function formatLine(domain, operation, fields) {
  const payload = {};
  for (const key of KNOWN_FIELDS) {
    if (fields[key] !== undefined && key !== 'operation') payload[key] = fields[key];
  }
  for (const [key, value] of Object.entries(fields)) {
    if (!KNOWN_FIELDS.includes(key) && value !== undefined) payload[key] = value;
  }
  const suffix = Object.keys(payload).length ? ` ${JSON.stringify(payload)}` : '';
  return `[${domain}] ${operation}${suffix}`;
}

/**
 * @param {{ log?: Function, warn?: Function, error?: Function }} [baseLogger]
 * @param {{ domain?: string }} [options]
 */
function createStructuredLogger(baseLogger = console, { domain = 'app' } = {}) {
  const emit = (level, operation, fields = {}) => {
    const line = formatLine(domain, String(operation || ''), fields || {});
    const sink = baseLogger?.[level] || baseLogger?.log;
    try { sink?.call(baseLogger, line); } catch (_) {}
    return line;
  };
  return {
    info: (operation, fields) => emit('log', operation, fields),
    warn: (operation, fields) => emit('warn', operation, fields),
    error: (operation, fields) => emit('error', operation, fields),
  };
}

module.exports = { createStructuredLogger };
