(function initAiFreeMessageUtils(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.AiFreeMessageUtils = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createMessageUtils() {
  function sanitizeUserFacingMessage(message, fallback = '账号分配失败') {
    let text = String(message || '').trim();
    if (!text) return fallback;

    text = text
      .replace(/获取\s*Cookie/gi, '获取账号信息')
      .replace(/Cookie\s*获取/gi, '账号信息获取')
      .replace(/Cookies?/gi, '账号信息')
      .replace(/cookie/gi, '账号信息')
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return text || fallback;
  }

  return {
    sanitizeUserFacingMessage,
  };
});
