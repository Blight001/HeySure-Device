(function initAiFreeTextPreviewUtils(root, factory) {
  const api = factory(root);

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.AiFreeTextPreviewUtils = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createTextPreviewUtils(root) {
  function previewText(value, maxLen = 220) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
  }

  function decodeBase64Utf8(raw) {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(raw, 'base64').toString('utf8');
    }

    const atobFn = root && typeof root.atob === 'function' ? root.atob.bind(root) : null;
    if (!atobFn) return '';

    const binary = atobFn(raw);
    if (root && typeof root.TextDecoder === 'function') {
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new root.TextDecoder('utf-8').decode(bytes);
    }

    try {
      return decodeURIComponent(escape(binary));
    } catch (_) {
      return binary;
    }
  }

  function decodeBase64Preview(value, maxLen = 220) {
    const raw = String(value || '').replace(/\s+/g, '').trim();
    if (!raw || raw.length < 32 || raw.length % 4 !== 0 || !/^[A-Za-z0-9+/=]+$/.test(raw)) {
      return '';
    }
    try {
      const decoded = decodeBase64Utf8(raw).replace(/^\uFEFF/, '').trim();
      if (!decoded || /[\uFFFD]/.test(decoded)) return '';
      return previewText(decoded, maxLen);
    } catch (_) {
      return '';
    }
  }

  return {
    decodeBase64Preview,
    previewText,
  };
});
