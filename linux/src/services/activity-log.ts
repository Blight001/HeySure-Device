// Activity log dispatcher. Main process attaches `bindActivityLogTarget` once;
// every module can then call `sendActivityLog(...)` without holding a window
// reference. Falls back to a no-op when no window is bound (e.g. during boot).

import type { BrowserWindow } from 'electron'

export type ActivityLevel = 'info' | 'warn' | 'error' | 'system' | 'task'
export type ActivityStatus = 'info' | 'success' | 'error' | 'running' | 'warn'

export interface ActivityEntry {
  id: string
  type: string
  status: string
  message: string
  data?: any
  timestamp: number
}

let target: BrowserWindow | null = null

export function bindActivityLogTarget(win: BrowserWindow | null): void {
  target = win
}

export function sendActivityLog(
  type: string,
  status: string,
  message: string,
  data?: any,
): void {
  const entry: ActivityEntry = {
    id: Math.random().toString(36).slice(2),
    type, status, message, data,
    timestamp: Date.now(),
  }
  target?.webContents.send('activity:log', entry)
}
