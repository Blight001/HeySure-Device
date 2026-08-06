'use strict';

const STATE_VERSION = 1;
const DEFAULT_BOUNDS = Object.freeze({ width: 1440, height: 900 });
const MIN_WIDTH = 800;
const MIN_HEIGHT = 600;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function resolveWorkArea(screen, bounds) {
  try {
    const display = screen?.getDisplayMatching?.(bounds);
    const area = display?.workArea;
    if (area && finiteNumber(area.width) > 0 && finiteNumber(area.height) > 0) return area;
  } catch (_) {}
  return null;
}

function normalizeBounds(candidate, screen) {
  const source = candidate && typeof candidate === 'object' ? candidate : {};
  const requested = {
    x: finiteNumber(source.x),
    y: finiteNumber(source.y),
    width: finiteNumber(source.width) || DEFAULT_BOUNDS.width,
    height: finiteNumber(source.height) || DEFAULT_BOUNDS.height,
  };
  const workArea = resolveWorkArea(screen, requested);
  if (!workArea) {
    const result = { width: Math.max(MIN_WIDTH, requested.width), height: Math.max(MIN_HEIGHT, requested.height) };
    if (requested.x !== null && requested.y !== null) Object.assign(result, { x: requested.x, y: requested.y });
    return result;
  }
  const width = Math.min(Math.max(MIN_WIDTH, requested.width), workArea.width);
  const height = Math.min(Math.max(MIN_HEIGHT, requested.height), workArea.height);
  if (requested.x === null || requested.y === null) return { width, height };
  return {
    x: Math.min(Math.max(requested.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(requested.y, workArea.y), workArea.y + workArea.height - height),
    width,
    height,
  };
}

function readWindowState(deps, statePath) {
  const temporaryPath = `${statePath}.tmp`;
  try {
    if (!deps.fs.existsSync(statePath)) return null;
    const parsed = JSON.parse(deps.fs.readFileSync(statePath, 'utf8'));
    if (parsed?.version !== STATE_VERSION || !parsed.bounds) return null;
    return {
      version: STATE_VERSION,
      maximized: parsed.maximized === true,
      bounds: normalizeBounds(parsed.bounds, deps.screen),
    };
  } catch (error) {
    deps.logger.warn?.('[WindowState] 读取主窗口状态失败，使用默认大窗口:', error?.message || error);
    return null;
  } finally {
    try { if (deps.fs.existsSync(temporaryPath)) deps.fs.unlinkSync(temporaryPath); } catch (_) {}
  }
}

function writeWindowState(deps, statePath, state) {
  const temporaryPath = `${statePath}.tmp`;
  try {
    deps.fs.mkdirSync(deps.path.dirname(statePath), { recursive: true });
    deps.fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    deps.fs.renameSync(temporaryPath, statePath);
    return true;
  } catch (error) {
    deps.logger.warn?.('[WindowState] 保存主窗口状态失败:', error?.message || error);
    return false;
  } finally {
    try { if (deps.fs.existsSync(temporaryPath)) deps.fs.unlinkSync(temporaryPath); } catch (_) {}
  }
}

function createAppShellWindowStateController(deps = {}) {
  const statePath = deps.path.join(deps.app.getPath('userData'), 'app-window-state.json');
  let state = readWindowState(deps, statePath) || {
    version: STATE_VERSION,
    maximized: true,
    bounds: { ...DEFAULT_BOUNDS },
  };
  let saveTimer = null;

  const flush = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    return writeWindowState(deps, statePath, state);
  };
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 180);
    saveTimer.unref?.();
  };
  const capture = (window, immediate = false) => {
    if (!window || window.isDestroyed?.() || window.isMinimized?.()) return;
    const maximized = window.isMaximized?.() === true;
    const bounds = maximized ? window.getNormalBounds?.() : window.getBounds?.();
    if (bounds) state = { version: STATE_VERSION, maximized, bounds: normalizeBounds(bounds, deps.screen) };
    if (immediate) flush(); else scheduleSave();
  };
  const bindWindow = (window) => {
    ['resize', 'move', 'maximize', 'unmaximize'].forEach((eventName) => {
      window.on(eventName, () => capture(window));
    });
    window.on('close', () => capture(window, true));
    window.on('closed', () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
    });
  };

  return {
    bindWindow,
    flush,
    getWindowOptions: () => ({ ...state.bounds }),
    shouldMaximize: () => state.maximized,
  };
}

module.exports = {
  createAppShellWindowStateController,
  normalizeBounds,
};
