'use strict';

const SIDEBAR_WIDTH_RATIO = 0.3;

/**
 * @param {unknown} value
 */
function positiveWidth(value) {
  const width = Math.floor(Number(value));
  return Number.isFinite(width) && width > 0 ? width : 0;
}

/**
 * @param {{
 *   contentWidth?: number,
 *   isVisible?: boolean,
 *   isMaximized?: boolean,
 *   currentWidth?: number,
 *   normalWindowWidth?: number,
 * }} options
 */
function resolveSidebarWidth({
  contentWidth,
  isVisible = true,
  isMaximized = false,
  currentWidth = 0,
  normalWindowWidth = 0,
} = /** @type {Parameters<typeof resolveSidebarWidth>[0]} */ ({})) {
  const availableWidth = positiveWidth(contentWidth);
  if (!isVisible || availableWidth === 0) return 0;
  if (isMaximized) {
    const retainedWidth = positiveWidth(currentWidth);
    if (retainedWidth > 0 && retainedWidth < availableWidth) return retainedWidth;
    const normalWidth = positiveWidth(normalWindowWidth);
    if (normalWidth > 0) {
      return Math.max(1, Math.min(availableWidth, Math.floor(normalWidth * SIDEBAR_WIDTH_RATIO)));
    }
  }
  return Math.max(1, Math.floor(availableWidth * SIDEBAR_WIDTH_RATIO));
}

module.exports = { resolveSidebarWidth };
