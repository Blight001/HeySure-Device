import { BrowserWindow } from 'electron'
import * as path from 'path'
import { store } from '../store'

const DEFAULT_BOUNDS = { width: 760, height: 700 }

let offlineChatWindow: BrowserWindow | null = null

export function createOfflineChatWindow(): BrowserWindow {
  if (offlineChatWindow && !offlineChatWindow.isDestroyed()) {
    offlineChatWindow.show()
    offlineChatWindow.focus()
    return offlineChatWindow
  }

  const iconPath = path.join(__dirname, '../../assets/icon.ico')
  offlineChatWindow = new BrowserWindow({
    width: DEFAULT_BOUNDS.width,
    height: DEFAULT_BOUNDS.height,
    minWidth: 560,
    minHeight: 520,
    icon: iconPath,
    title: 'HeySure 本地对话',
    autoHideMenuBar: true,
    backgroundColor: store.get('theme') === 'light' ? '#f7f7fb' : '#111827',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '../preload.js'),
    },
  })

  offlineChatWindow.loadFile(path.join(__dirname, '../renderer/offline-chat.html'))
  offlineChatWindow.setMenuBarVisibility(false)
  offlineChatWindow.on('closed', () => { offlineChatWindow = null })
  return offlineChatWindow
}

export function showOfflineChatWindow(): void {
  createOfflineChatWindow()
}
