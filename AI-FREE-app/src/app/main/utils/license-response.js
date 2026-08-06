function pickFirstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function pickFirstValue(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    return value;
  }
  return null;
}

function extractNestedText(source) {
  if (!source || typeof source !== 'object') return '';
  return pickNestedFieldText(source,
    ['message', 'msg', 'error', 'reason', 'detail', 'description', 'error_description', 'errorMessage'],
    ['', 'data', 'result', 'payload', 'announcement']);
}

function pickNestedFieldText(source, fields, containers) {
  for (const containerName of containers) {
    const container = containerName ? source[containerName] : source;
    if (!container || typeof container !== 'object') continue;
    const value = pickFirstText(...fields.map((field) => container[field]));
    if (value) return value;
  }
  return '';
}

function extractValidationState(source) {
  if (!source || typeof source !== 'object') return '';
  const fields = ['code', 'error_code', 'errorCode', 'card_state', 'cardState', 'state', 'status', 'message_type'];
  const raw = pickNestedFieldText(source, fields, ['', 'result', 'data', 'payload']).toLowerCase();

  if (!raw) return '';
  if (['active', 'success', 'valid', 'enabled', 'normal', 'ok', 'passed', 'pass'].includes(raw)) return 'active';
  if (['disabled', 'disable', 'inactive', 'blocked', 'banned', 'revoked', 'forbidden', 'frozen', 'card_disabled', 'card_blocked', 'card_revoked'].includes(raw)) return 'disabled';
  if (['expired', 'expire', 'expired_at', 'overdue'].includes(raw)) return 'expired';
  if (['not_found', 'missing', 'absent', 'none', 'unfound', 'card_not_found', 'notexist', 'not_exist'].includes(raw)) return 'not_found';
  if (['pending', 'pending_activation', 'not_started', 'unverified', 'not_active'].includes(raw)) return 'pending';
  return raw;
}

function isValidationSuccess(resp) {
  if (!resp || typeof resp !== 'object') return false;
  if (resp.valid === true || resp.is_valid === true || resp.success === true || resp.ok === true) return true;
  return extractValidationState(resp) === 'active';
}

function getValidationFailureMessage(resp, fallback = '账号会话无效或已过期，请重新登录') {
  const message = extractNestedText(resp);
  if (message) return message;

  const state = extractValidationState(resp);
  const stateMessages = {
    not_found: '账号不存在',
    expired: '账号会话已过期，请重新登录',
    disabled: '账号已被禁用',
    revoked: '账号会话已失效，请重新登录',
    pending: '账号暂未生效',
    active: '',
  };
  if (Object.prototype.hasOwnProperty.call(stateMessages, state) && stateMessages[state]) {
    return stateMessages[state];
  }

  if (resp && (resp.valid === false || resp.is_valid === false || resp.success === false || resp.ok === false)) {
    return fallback;
  }

  return fallback;
}

module.exports = {
  extractNestedText,
  extractValidationState,
  getValidationFailureMessage,
  isValidationSuccess,
  pickFirstText,
  pickFirstValue,
};
