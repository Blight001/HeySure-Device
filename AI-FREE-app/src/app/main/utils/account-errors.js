const USAGE_EXHAUSTED_MESSAGE_RE = /次数.*用尽|使用次数已用尽|卡密使用次数已用尽/;

function isUsageExhaustedFetchError(error) {
  const message = String(error?.message || error?.error || '').trim();
  return USAGE_EXHAUSTED_MESSAGE_RE.test(message);
}

module.exports = {
  isUsageExhaustedFetchError,
};
