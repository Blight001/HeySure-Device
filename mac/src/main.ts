// Application entry point. Owns the Electron lifecycle and stitches together
// the smaller modules (windows, tray, agent runtime, IPC). Keep this file
// short — each piece of real logic lives in its own module.

import { app, Menu, dialog } from 'electron'
import * as path from 'path'
import { store, ensureDeviceId } from './store'
import { initCapture } from './capture-bridge'
import { createMainWindow, getMainWindow } from './windows/main-window'
import { createTray, updateTray } from './windows/tray'
import {
  initAgent, getAgent, clearAiSelectionIfLoggedOut, isAgentActive,
} from './services/device-runtime'
import { bindActivityLogTarget } from './services/activity-log'
import { registerAllIpc } from './ipc'
import { initializeDynamicMcp } from './executor/dynamic'
import { initRemoteControlHost } from './remote/remote-control-host'
import { initArtifactBridge } from './runtime/artifact-bridge'
import { registerConfirmHandler } from './runtime/permission-guard'
import { pauseExecution, resumeExecution, isExecutionPaused } from './runtime/process-guard'

// Wire the controlled-executor base into the Electron host: artifacts dir,
// confirm-tier permission prompts, and the tray pause/resume switch.
function initRuntimeBase(): void {
  initArtifactBridge(path.join(app.getPath('userData'), 'artifacts'))
  registerConfirmHandler(async (req) => {
    const win = getMainWindow()
    const options = {
      type: 'warning' as const,
      buttons: ['允许', '拒绝'],
      defaultId: 1,
      cancelId: 1,
      title: '需要确认',
      message: `AI 请求执行工具：${req.tool}`,
      detail: `涉及权限：${req.reasons.join(', ')}${req.summary ? `\n\n${req.summary}` : ''}`,
    }
    const { response } = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options)
    return response === 0
  })
}

app.setName('HeySure Agent')
if (process.platform === 'win32') {
  app.setAppUserModelId('com.heysure.agent.win')
  app.commandLine.appendSwitch('force-renderer-accessibility', 'complete')
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  ;(app as any).isQuitting = true
  app.quit()
}

app.on('second-instance', () => {
  const w = getMainWindow()
  if (!w) return
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
})

async function bootstrap(): Promise<void> {
  if (process.platform === 'win32') {
    app.setAccessibilitySupportEnabled(true)
  }

  initCapture()

  clearAiSelectionIfLoggedOut()
  ensureDeviceId()
  initAgent(store.store)
  initRuntimeBase()
  initializeDynamicMcp(() => getAgent()?.refreshRegistration())

  registerAllIpc()
  initRemoteControlHost()
  Menu.setApplicationMenu(null)

  const mainWindow = createMainWindow()
  bindActivityLogTarget(mainWindow)

  createTray({
    onToggleConnection: () => {
      const agent = getAgent()
      if (isAgentActive()) agent?.disconnect()
      else agent?.connect()
    },
    onShowPanel: () => {
      const w = getMainWindow()
      if (w?.isVisible()) w.hide()
      else { w?.show(); w?.focus() }
    },
    isActive: isAgentActive,
    onTogglePause: () => {
      if (isExecutionPaused()) resumeExecution()
      else pauseExecution('user')
      updateTray(getAgent()?.status || 'disconnected')
    },
    isPaused: isExecutionPaused,
  })
  updateTray(getAgent()?.status || 'disconnected')

  // Auto-connect as soon as the user is logged in. The AI assignment is now
  // controlled server-side (Workshop panel), so we no longer gate on a locally
  // selected AI member.
  if (store.get('authToken')) {
    getAgent()?.connect()
  }
}

if (hasSingleInstanceLock) {
  app.whenReady().then(bootstrap)
}

// Keep running in tray when all windows are closed
app.on('window-all-closed', (e: Event) => { e.preventDefault() })

app.on('before-quit', () => {
  ;(app as any).isQuitting = true
  getAgent()?.disconnect()
})

app.on('activate', () => { getMainWindow()?.show() })
