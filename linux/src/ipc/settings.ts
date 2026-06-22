import { ipcMain } from 'electron'
import { store, AgentSettings } from '../store'
import { executeCapture, getCaptureDisplayGeometry } from '../capture-bridge'
import { getAgent, clearAiSelectionIfLoggedOut } from '../services/device-runtime'
import { sendActivityLog } from '../services/activity-log'
import { getCoordinateCalibration, rememberCaptureGeometry } from '../tools/shared/coordinates'
import { getRobot, sleep } from '../tools/shared/robot'
import {
  setMainWindowTheme,
  minimizeMainWindow,
  toggleMaximizeMainWindow,
  closeMainWindow,
  isMainWindowMaximized,
} from '../windows/main-window'
import { fetchAgentEndpoint, resolveBaseUrl, serverFetch, ServerError } from '../services/server-client'
import { cacheUserAvatar } from '../services/avatar-cache'

function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length <= 24) return { width: 0, height: 0 }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function roundScale(value: number): number {
  return Math.round(value * 10000) / 10000
}

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get', async () => {
    clearAiSelectionIfLoggedOut()
    const s = store.store
    if (s.serverUrl && s.authToken) {
      try {
        const base = resolveBaseUrl(s.serverUrl)
        const me = await serverFetch<any>(base, '/api/auth/me', {
          token: s.authToken,
          failureMessage: '登录状态校验失败',
          timeoutMs: 5000,
        })
        // Keep the cached avatar in sync if it changed server-side (mirrors the
        // browser extension's getMe refresh); re-fetch the image only as needed.
        const freshAvatar = me && typeof me === 'object' ? String(me.avatar || '') : s.userAvatar
        if (freshAvatar !== s.userAvatar) {
          store.set('userAvatar', freshAvatar)
          await cacheUserAvatar(base, freshAvatar)
        } else if (s.userAvatar && !s.userAvatarDataUrl) {
          await cacheUserAvatar(base, s.userAvatar)
        }
        const agentSocketUrl = await fetchAgentEndpoint(base, s.authToken)
        if (agentSocketUrl !== s.agentSocketUrl) {
          store.set('agentSocketUrl', agentSocketUrl)
          getAgent()?.updateSettings(store.store)
        }
      } catch (err) {
        if (!(err instanceof ServerError && err.status === 401)) {
          // Network/server errors should not log the user out. They are handled
          // by the feature call that needs the server connection.
        }
      }
    }
    return store.store
  })

  ipcMain.handle('settings:save', (_event, newSettings: Partial<AgentSettings>) => {
    const serverUrlChanged = newSettings.serverUrl !== undefined && newSettings.serverUrl !== store.get('serverUrl')
    if (serverUrlChanged && newSettings.agentSocketUrl === undefined) {
      newSettings.agentSocketUrl = ''
    }
    const agentAffectingKeys = new Set<keyof AgentSettings>([
      'serverUrl',
      'agentSocketUrl',
      'agentToken',
      'deviceId',
      'agentName',
      'agentGroup',
      'workspaceRoot',
      'authToken',
      'userId',
      'userName',
    ])
    const shouldRefreshAgent = Object.keys(newSettings || {}).some(k => agentAffectingKeys.has(k as keyof AgentSettings))
    Object.entries(newSettings).forEach(([k, v]) => store.set(k as any, v as any))
    if (clearAiSelectionIfLoggedOut()) {
      sendActivityLog('system', 'warn', '未登录，已取消 AI 成员自动注册选择')
    }
    if (shouldRefreshAgent) getAgent()?.updateSettings(store.store)
    return store.store
  })

  ipcMain.handle('settings:auto-calibrate-mouse', async () => {
    const displayIndex = 0
    const buf = await executeCapture({ displayIndex })
    const capture = pngSize(buf)
    if (!capture.width || !capture.height) throw new Error('无法读取截图尺寸')
    rememberCaptureGeometry({ capture, display: getCaptureDisplayGeometry(displayIndex) })

    const calibration = getCoordinateCalibration()
    const frame = calibration.frame
    if (!frame || !frame.width || !frame.height) throw new Error('无法获取屏幕校准几何信息')

    const robot = getRobot()
    const targetCapture = {
      x: Math.max(1, capture.width - 1),
      y: Math.max(1, capture.height - 1),
    }
    const targetRobot = {
      x: Math.round(Number(frame.x || 0) + Number(frame.width) - 1),
      y: Math.round(Number(frame.y || 0) + Number(frame.height) - 1),
    }
    robot.moveMouse(targetRobot.x, targetRobot.y)
    await sleep(40)
    robot.mouseClick('left')
    await sleep(80)

    const cursor = robot.getMousePos()
    const autoScaleX = Number(frame.width) / Number(capture.width)
    const autoScaleY = Number(frame.height) / Number(capture.height)
    const scaleX = (Number(cursor.x) - Number(frame.x || 0)) / (targetCapture.x * autoScaleX)
    const scaleY = (Number(cursor.y) - Number(frame.y || 0)) / (targetCapture.y * autoScaleY)
    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
      throw new Error('自动校准计算失败')
    }

    const nextScaleX = roundScale(scaleX)
    const nextScaleY = roundScale(scaleY)
    store.set('mouseCoordinateScaleX', nextScaleX)
    store.set('mouseCoordinateScaleY', nextScaleY)
    store.set('mouseCoordinateOffsetX', 0)
    store.set('mouseCoordinateOffsetY', 0)

    return {
      success: true,
      mouseCoordinateScaleX: nextScaleX,
      mouseCoordinateScaleY: nextScaleY,
      mouseCoordinateOffsetX: 0,
      mouseCoordinateOffsetY: 0,
      capture,
      frame,
      targetRobot,
      cursor: { x: Number(cursor.x), y: Number(cursor.y) },
    }
  })

  ipcMain.handle('theme:set', (_event, theme: 'dark' | 'light') => {
    store.set('theme', theme)
    setMainWindowTheme(theme)
    return true
  })

  ipcMain.handle('window:minimize', () => {
    minimizeMainWindow()
    return true
  })

  ipcMain.handle('window:toggle-maximize', () => {
    return toggleMaximizeMainWindow()
  })

  ipcMain.handle('window:close', () => {
    closeMainWindow()
    return true
  })

  ipcMain.handle('window:is-maximized', () => {
    return isMainWindowMaximized()
  })
}
