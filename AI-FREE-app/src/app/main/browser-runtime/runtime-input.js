'use strict';

const MOUSE_ACTIONS = new Set(['click', 'double_click', 'right_click']);
const MAX_VIEWPORT_COORDINATE = 1_000_000;

function inputError(code, message) {
  const error = /** @type {Error & {code?: string}} */ (new Error(message));
  error.code = code;
  return error;
}

function validCoordinate(value) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= MAX_VIEWPORT_COORDINATE;
}

function normalizeRuntimeInput(source = {}) {
  const inputType = String(source.inputType || '').trim();
  const action = String(source.action || '').trim();
  if (inputType !== 'mouse' || !MOUSE_ACTIONS.has(action)) {
    throw inputError('INPUT_PAYLOAD_INVALID', '仅支持 click/double_click/right_click 鼠标输入');
  }
  if (!validCoordinate(source.x) || !validCoordinate(source.y)
      || !validCoordinate(source.viewportWidth) || !validCoordinate(source.viewportHeight)
      || source.viewportWidth <= 0 || source.viewportHeight <= 0
      || source.x >= source.viewportWidth || source.y >= source.viewportHeight) {
    throw inputError('INPUT_PAYLOAD_INVALID', '鼠标输入需要位于当前视口内的有效坐标和视口尺寸');
  }
  return {
    inputType, action, x: source.x, y: source.y,
    viewportWidth: source.viewportWidth,
    viewportHeight: source.viewportHeight,
  };
}

function findProfileIdByProcessId(instances, processId) {
  const pid = Number(processId || 0) || 0;
  if (!pid || !instances || typeof instances.entries !== 'function') return '';
  for (const [profileId, instance] of instances.entries()) {
    if (Number(instance?.child?.pid || 0) === pid && instance.child.exitCode === null) {
      return String(profileId || '');
    }
  }
  return '';
}

async function dispatchRuntimeInput(runtime, profileId, source) {
  const input = normalizeRuntimeInput(source);
  return runtime.enqueueProfileOperation(profileId, () => (
    runtime.getReadyInstance(profileId).commandClient.send('dispatch-input', input)
  ));
}

async function dispatchRuntimeInputByProcessId(runtime, processId, source) {
  const profileId = findProfileIdByProcessId(runtime.instances, processId);
  if (profileId) return dispatchRuntimeInput(runtime, profileId, source);
  const error = /** @type {Error & {code?: string}} */ (
    new Error(`Chromium 进程 ${Number(processId || 0) || '<empty>'} 不属于当前受管 Profile`)
  );
  error.code = 'CHROMIUM_PROCESS_NOT_MANAGED';
  throw error;
}

module.exports = {
  MAX_VIEWPORT_COORDINATE,
  MOUSE_ACTIONS,
  dispatchRuntimeInput,
  dispatchRuntimeInputByProcessId,
  findProfileIdByProcessId,
  normalizeRuntimeInput,
};
