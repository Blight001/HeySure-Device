/** @param {Record<string, any>} [source] */
function normalizeCardCacheState(source = {}) {
  /** @type {Record<string, any>} */
  const value = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const items = Array.isArray(value.items)
    ? value.items.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    : [];
  const requestedSelectedId = String(value.selectedId || '').trim();
  const selectedId = items.some((item) => String(item.id || '').trim() === requestedSelectedId)
    ? requestedSelectedId
    : String(items[0]?.id || '').trim();
  return { items, selectedId };
}

/** @param {Record<string, any>} [source] */
function normalizeBrowserToolOutcome(source = {}) {
  /** @type {Record<string, any>} */
  const payload = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const rawResult = payload.result;
  const result = rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult)
    ? { ...rawResult }
    : (rawResult === undefined ? {} : { value: rawResult });
  if (!hasBrowserToolFailure(payload, result)) return rawResult;

  const error = firstNonEmptyString(
    result.error, result.errorReason, result.message, payload.error, '浏览器工具执行失败',
  );
  const errorCode = firstNonEmptyString(
    result.errorCode, result.code, payload.errorCode, 'BROWSER_TOOL_FAILED',
  );
  return {
    ...result,
    success: false,
    error,
    errorReason: String(result.errorReason || error),
    errorCode,
  };
}

function hasBrowserToolFailure(payload, result) {
  return [payload.success === false, Boolean(payload.error), result.success === false, result.ok === false]
    .some(Boolean);
}

function firstNonEmptyString(...values) {
  return values.map((value) => String(value || '').trim()).find(Boolean) || '';
}

module.exports = { normalizeBrowserToolOutcome, normalizeCardCacheState };
