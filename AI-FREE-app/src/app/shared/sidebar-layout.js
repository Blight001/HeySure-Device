'use strict';

const SIDEBAR_WIDTH_RATIO = 0.3;
const SIDEBAR_MIN_WIDTH = 280;
const SIDEBAR_MAX_WIDTH = 720;
const MAIN_CONTENT_MIN_WIDTH = 320;

/**
 * @param {unknown} value
 */
function positiveWidth(value) {
  const width = Math.floor(Number(value));
  return Number.isFinite(width) && width > 0 ? width : 0;
}

/**
 * @param {unknown} value
 * @param {unknown} contentWidth
 */
function clampSidebarWidth(value, contentWidth) {
  const requestedWidth = positiveWidth(value);
  const availableWidth = positiveWidth(contentWidth);
  if (requestedWidth === 0 || availableWidth === 0) return 0;
  const maximum = Math.max(1, Math.min(SIDEBAR_MAX_WIDTH, availableWidth - MAIN_CONTENT_MIN_WIDTH));
  const minimum = Math.min(SIDEBAR_MIN_WIDTH, maximum);
  return Math.max(minimum, Math.min(maximum, requestedWidth));
}

function resolveRetainedSidebarWidth(options, availableWidth) {
  const retainedCurrentWidth = positiveWidth(options.currentWidth);
  if (options.retainCurrentWidth && retainedCurrentWidth > 0 && retainedCurrentWidth < availableWidth) {
    return retainedCurrentWidth;
  }
  const retainedPreference = clampSidebarWidth(options.preferredWidth, availableWidth);
  if (retainedPreference > 0) return retainedPreference;
  if (!options.isMaximized) return 0;
  if (retainedCurrentWidth > 0 && retainedCurrentWidth < availableWidth) return retainedCurrentWidth;
  const normalWidth = positiveWidth(options.normalWindowWidth);
  if (normalWidth === 0) return 0;
  return Math.max(1, Math.min(availableWidth, Math.floor(normalWidth * SIDEBAR_WIDTH_RATIO)));
}

/**
 * @param {{
 *   contentWidth?: number,
 *   isVisible?: boolean,
 *   isMaximized?: boolean,
 *   currentWidth?: number,
 *   normalWindowWidth?: number,
 *   preferredWidth?: number,
 *   retainCurrentWidth?: boolean,
 * }} options
 */
function resolveSidebarWidth({
  contentWidth,
  isVisible = true,
  isMaximized = false,
  currentWidth = 0,
  normalWindowWidth = 0,
  preferredWidth = 0,
  retainCurrentWidth = false,
} = /** @type {Parameters<typeof resolveSidebarWidth>[0]} */ ({})) {
  const availableWidth = positiveWidth(contentWidth);
  if (!isVisible || availableWidth === 0) return 0;
  const retainedWidth = resolveRetainedSidebarWidth({
    currentWidth, isMaximized, normalWindowWidth, preferredWidth, retainCurrentWidth,
  }, availableWidth);
  if (retainedWidth > 0) return retainedWidth;
  return Math.max(1, Math.floor(availableWidth * SIDEBAR_WIDTH_RATIO));
}

module.exports = { clampSidebarWidth, resolveSidebarWidth };
