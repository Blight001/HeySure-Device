(function initAiFreeVersionUtils(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.AiFreeVersionUtils = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createVersionUtils() {
  function stripVersionPrefix(value) {
    return String(value || '').trim().replace(/^v/i, '');
  }

  function normalizeVersion(value) {
    const text = stripVersionPrefix(value).split('+', 1)[0];
    if (!text) return { parts: [0], preRelease: '' };

    const [mainPart, preRelease = ''] = text.split('-', 2);
    const parts = mainPart
      .split('.')
      .map((segment) => Number.parseInt(segment, 10))
      .map((num) => (Number.isFinite(num) ? num : 0));

    while (parts.length > 1 && parts[parts.length - 1] === 0) {
      parts.pop();
    }

    return { parts, preRelease };
  }

  function comparePreRelease(left, right) {
    const a = String(left || '').split('.');
    const b = String(right || '').split('.');
    const maxLen = Math.max(a.length, b.length);

    for (let i = 0; i < maxLen; i += 1) {
      if (a[i] === undefined) return -1;
      if (b[i] === undefined) return 1;
      if (a[i] === b[i]) continue;

      const aNumeric = /^\d+$/.test(a[i]);
      const bNumeric = /^\d+$/.test(b[i]);
      if (aNumeric && bNumeric) {
        const av = Number(a[i]);
        const bv = Number(b[i]);
        if (av > bv) return 1;
        if (av < bv) return -1;
        continue;
      }
      if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
      return a[i] > b[i] ? 1 : -1;
    }

    return 0;
  }

  function compareVersions(left, right) {
    const a = normalizeVersion(left);
    const b = normalizeVersion(right);
    const maxLen = Math.max(a.parts.length, b.parts.length);

    for (let i = 0; i < maxLen; i += 1) {
      const av = a.parts[i] || 0;
      const bv = b.parts[i] || 0;
      if (av > bv) return 1;
      if (av < bv) return -1;
    }

    if (a.preRelease && !b.preRelease) return -1;
    if (!a.preRelease && b.preRelease) return 1;
    if (a.preRelease && b.preRelease && a.preRelease !== b.preRelease) {
      return comparePreRelease(a.preRelease, b.preRelease);
    }

    return 0;
  }

  return {
    stripVersionPrefix,
    normalizeVersion,
    comparePreRelease,
    compareVersions,
  };
});
