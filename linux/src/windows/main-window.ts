import { BrowserWindow, app } from 'electron'
import * as path from 'path'
import { store } from '../store'
import { platformProfile } from '../platform'
import { resolveAssetsDir } from '../asset-path'

const DEFAULT_BOUNDS = { width: 900, height: 660 }
const THEME_WINDOW_COLORS = {
  dark: '#0e0e1a',
  light: '#f0f0ff',
} as const

let mainWindow: BrowserWindow | null = null

export function createMainWindow(): BrowserWindow {
  const bounds = (store.get('windowBounds') as any) || DEFAULT_BOUNDS
  const iconPath = path.join(resolveAssetsDir(), platformProfile.appIconFile)

  mainWindow = new BrowserWindow({
    width: bounds.width || DEFAULT_BOUNDS.width,
    height: bounds.height || DEFAULT_BOUNDS.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 700,
    minHeight: 500,
    icon: iconPath,
    frame: false,
    autoHideMenuBar: true,
    title: 'HeySure Agent',
    backgroundColor: THEME_WINDOW_COLORS[store.get('theme') === 'light' ? 'light' : 'dark'],
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '../preload.js'),
    },
  })

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  mainWindow.setMenuBarVisibility(false)

  mainWindow.on('close', (e) => {
    if (!(app as any).isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  const saveBounds = () => {
    if (!mainWindow) return
    store.set('windowBounds', mainWindow.getBounds())
  }
  mainWindow.on('resize', saveBounds)
  mainWindow.on('move', saveBounds)

  return mainWindow
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function setMainWindowTheme(theme: 'dark' | 'light'): void {
  mainWindow?.setBackgroundColor(THEME_WINDOW_COLORS[theme])
}

export function minimizeMainWindow(): void {
  mainWindow?.minimize()
}

export function toggleMaximizeMainWindow(): boolean {
  if (!mainWindow) return false
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
  return mainWindow.isMaximized()
}

export function closeMainWindow(): void {
  mainWindow?.close()
}

export function isMainWindowMaximized(): boolean {
  return !!mainWindow?.isMaximized()
}
