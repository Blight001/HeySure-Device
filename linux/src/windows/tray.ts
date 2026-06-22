import { Tray, Menu, app, nativeImage } from 'electron'
import * as path from 'path'
import type { DeviceStatus } from '../device'
import { platformProfile } from '../platform'

const ASSET_DIR = path.join(__dirname, '../../assets')
const APP_ICON_PATH = path.join(ASSET_DIR, platformProfile.appIconFile)

const TRAY_ICON_PATHS: Record<DeviceStatus, string> = {
  disconnected: path.join(ASSET_DIR, 'desktop.png'),
  connecting:   path.join(ASSET_DIR, 'desktop_yellow.png'),
  connected:    path.join(ASSET_DIR, 'desktop_green.png'),
  registered:   path.join(ASSET_DIR, 'desktop_green.png'),
  error:        path.join(ASSET_DIR, 'desktop_red.png'),
}

export const STATUS_LABELS: Record<DeviceStatus, string> = {
  disconnected: '未连接',
  connecting:   '连接中...',
  connected:    '已连接',
  registered:   '已注册',
  error:        '连接错误',
}

function loadTrayIcon(status: DeviceStatus): Electron.NativeImage {
  const iconPath = TRAY_ICON_PATHS[status] || TRAY_ICON_PATHS.disconnected
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) {
    return nativeImage.createFromPath(APP_ICON_PATH)
  }
  return image.resize({ width: 16, height: 16 })
}

export interface TrayCallbacks {
  onToggleConnection: () => void
  onShowPanel: () => void
  isActive: () => boolean
  // Pause/resume server-driven tool execution (process-guard). One-switch kill
  // of anything in flight — 设备端MCP代码下放长期方案 §7.1.
  onTogglePause: () => void
  isPaused: () => boolean
}

let tray: Tray | null = null
let callbacks: TrayCallbacks | null = null

export function createTray(cb: TrayCallbacks): Tray {
  callbacks = cb
  tray = new Tray(loadTrayIcon('disconnected'))
  tray.setToolTip('HeySure Agent — 未连接')
  updateTray('disconnected')
  tray.on('click', cb.onShowPanel)
  return tray
}

export function updateTray(status: DeviceStatus): void {
  if (!tray || !callbacks) return
  tray.setImage(loadTrayIcon(status))
  tray.setToolTip(`HeySure Agent — ${STATUS_LABELS[status]}`)

  const active = callbacks.isActive()
  const menu = Menu.buildFromTemplate([
    { label: `状态: ${STATUS_LABELS[status]}`, enabled: false },
    { type: 'separator' },
    { label: active ? '断开连接' : '连接服务器', click: callbacks.onToggleConnection },
    { label: callbacks.isPaused() ? '恢复远程执行' : '暂停远程执行', click: callbacks.onTogglePause },
    { label: '打开面板', click: callbacks.onShowPanel },
    { type: 'separator' },
    {
      label: '退出',
      click: () => { (app as any).isQuitting = true; app.quit() },
    },
  ])
  tray.setContextMenu(menu)
}
