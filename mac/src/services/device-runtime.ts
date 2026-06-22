// Glue around the HeySureAgent socket client. Owns the singleton instance,
// re-wires renderer events on construction, and exposes a small API the IPC
// layer + tray menu can call.

import { HeySureAgent } from '../device'
import { store, AgentSettings } from '../store'
import { getMainWindow } from '../windows/main-window'
import { sendActivityLog } from './activity-log'
import { recoverAuthSession } from './auth-state'
import { updateTray, STATUS_LABELS } from '../windows/tray'
import { platformProfile } from '../platform'

let agent: HeySureAgent | null = null

function buildAgent(settings: AgentSettings): HeySureAgent {
  return new HeySureAgent(settings, {
    onStatusChange: (status, reason, aiConfigId) => {
      updateTray(status)
      getMainWindow()?.webContents.send('device:status-changed', status, reason, aiConfigId ?? null)
      sendActivityLog(
        'system',
        status === 'registered' ? 'success' : status === 'error' ? 'error' : 'info',
        `状态变更: ${STATUS_LABELS[status]}${reason ? ` (${reason})` : ''}`,
      )
    },
    onLog: (level, message, data) => sendActivityLog(level, 'info', message, data),
    onAuthFailure: (reason) => {
      void recoverAuthSession(`登录已过期（${reason}），请重新登录`)
    },
    onReconnecting: (active, reason) => {
      // Just drive the orange UI prompt; the retry loop fires every couple of
      // seconds, so logging each attempt here would spam the activity log.
      getMainWindow()?.webContents.send('device:reconnecting', active, reason ?? null)
    },
    onTaskStart: (taskId, tool, args) => {
      getMainWindow()?.webContents.send('task:start', {
        taskId, tool, args, timestamp: Date.now(),
      })
      sendActivityLog('task', 'running', `[工具] ${tool}`, args)
    },
    onTaskResult: (taskId, tool, result, success) => {
      getMainWindow()?.webContents.send('task:result', {
        taskId, tool, result, success, timestamp: Date.now(),
      })
      sendActivityLog(
        'task',
        success ? 'success' : 'error',
        `${success ? '✓' : '✗'} ${tool}`,
        success ? (result?.summary || result) : result,
      )
    },
  })
}

export function initAgent(settings: AgentSettings): HeySureAgent {
  agent = buildAgent(settings)
  return agent
}

export function getAgent(): HeySureAgent | null {
  return agent
}

export function rebuildAgent(settings: AgentSettings): HeySureAgent {
  agent?.disconnect()
  agent = buildAgent(settings)
  return agent
}

export function isAgentActive(): boolean {
  const s = agent?.status
  return s === 'connected' || s === 'registered'
}

export function clearSelectedAiConfig(): void {
  store.set('selectedAiConfigId', null)
  store.set('selectedAiConfigName', '')
  store.set('selectedAiConfigRole', 'member')
  store.set('selectedAiConfigLifecycle', 'working')
  store.set('selectedAiConfigProject', '')
  store.set('agentToken', '')
  store.set('deviceId', '')
  store.set('agentName', platformProfile.agentName)
  store.set('agentGroup', '')
}

export function clearAiSelectionIfLoggedOut(): boolean {
  if (store.get('authToken')) return false
  if (!store.get('selectedAiConfigId')) return false
  clearSelectedAiConfig()
  return true
}
