import { contextBridge, ipcRenderer } from 'electron'

function cleanIpcError(err: any): Error {
  const message = String(err?.message || err || '')
  const cleaned = message.replace(/^Error invoking remote method '[^']+': Error:\s*/i, '')
  return new Error(cleaned || message || '请求失败')
}

contextBridge.exposeInMainWorld('heysureAPI', {
  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: any) => ipcRenderer.invoke('settings:save', settings),
  autoCalibrateMouse: () => ipcRenderer.invoke('settings:auto-calibrate-mouse').catch((err: any) => { throw cleanIpcError(err) }),
  // Agent control
  connect: () => ipcRenderer.invoke('device:connect'),
  disconnect: () => ipcRenderer.invoke('device:disconnect'),
  getStatus: () => ipcRenderer.invoke('device:status'),
  // Events from main to renderer
  onStatusChange: (cb: (status: string, reason?: string, aiConfigId?: number | null) => void) => {
    ipcRenderer.on('device:status-changed', (_, status, reason, aiConfigId) => cb(status, reason, aiConfigId))
  },
  onActivityLog: (cb: (entry: any) => void) => {
    ipcRenderer.on('activity:log', (_, entry) => cb(entry))
  },
  onTaskStart: (cb: (data: any) => void) => {
    ipcRenderer.on('task:start', (_, data) => cb(data))
  },
  onTaskResult: (cb: (data: any) => void) => {
    ipcRenderer.on('task:result', (_, data) => cb(data))
  },
  onAuthExpired: (cb: (reason: string) => void) => {
    ipcRenderer.on('auth:expired', (_, reason) => cb(reason))
  },
  onAuthRefreshed: (cb: () => void) => {
    ipcRenderer.on('auth:refreshed', () => cb())
  },
  onReconnecting: (cb: (active: boolean, reason: string | null) => void) => {
    ipcRenderer.on('device:reconnecting', (_, active, reason) => cb(active, reason))
  },
  // Theme
  setTheme: (theme: 'dark' | 'light') => ipcRenderer.invoke('theme:set', theme),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isWindowMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  // Connection test
  testConnection: () => ipcRenderer.invoke('connection:test'),
  // Auth
  login: (params: { serverUrl: string; account: string; password: string; remember?: boolean }) =>
    ipcRenderer.invoke('auth:login', params),
  logout: () => ipcRenderer.invoke('auth:logout'),
  // AI Config
  listAiConfigs: () => ipcRenderer.invoke('ai-config:list'),
  getAiRuntimeStatus: () => ipcRenderer.invoke('ai-config:runtime-status'),
  selectAiConfig: (cfg: any) => ipcRenderer.invoke('ai-config:select', cfg),
  cloneAiConfig: (configId: number) => ipcRenderer.invoke('ai-config:clone', configId),
  // MCP tool page
  mcpList: () => ipcRenderer.invoke('mcp:list'),
  mcpSaveDesc: (payload: { tool: string; description?: string; parameters?: Record<string, string> }) =>
    ipcRenderer.invoke('mcp:save-desc', payload),
  mcpSetEnabled: (payload: { tool: string; enabled: boolean }) => ipcRenderer.invoke('mcp:set-enabled', payload),
  mcpTest: (payload: { tool: string; args: Record<string, any> }) => ipcRenderer.invoke('mcp:test', payload),
  // Local chat window (IPC names kept for compatibility with the existing bundle)
  openOfflineChat: () => ipcRenderer.invoke('offline-chat:open'),
  getOfflineChatConfig: () => ipcRenderer.invoke('offline-chat:get-config'),
  saveOfflinePrompt: (prompt: string) => ipcRenderer.invoke('offline-chat:save-prompt', prompt),
  sendOfflineChat: (payload: { requestId?: string; messages: Array<{ role: 'user' | 'assistant'; content: string }>; prompt?: string; allowedTools?: string[] }) =>
    ipcRenderer.invoke('offline-chat:send', payload).catch((err: any) => { throw cleanIpcError(err) }),
  cancelOfflineChat: (payload: { requestId?: string }) => ipcRenderer.invoke('offline-chat:cancel', payload),
  onOfflineChatProgress: (cb: (event: any) => void) => {
    const handler = (_: any, event: any) => cb(event)
    ipcRenderer.on('offline-chat:progress', handler)
    return () => ipcRenderer.removeListener('offline-chat:progress', handler)
  },
  // Version
  version: process.env.npm_package_version || '1.0.0',
})

// Bridge for the hidden remote-control peer window (renderer/remote-control.ts).
// Kept separate from heysureAPI because only that one window uses it; the main
// process drives it via the rc:* channels.
contextBridge.exposeInMainWorld('heysureRC', {
  onStart: (cb: (data: any) => void) => ipcRenderer.on('rc:start', (_, data) => cb(data)),
  onAnswer: (cb: (data: any) => void) => ipcRenderer.on('rc:answer', (_, data) => cb(data)),
  onIce: (cb: (data: any) => void) => ipcRenderer.on('rc:ice', (_, data) => cb(data)),
  onStop: (cb: (data: any) => void) => ipcRenderer.on('rc:stop', (_, data) => cb(data)),
  signal: (event: string, payload: any) => ipcRenderer.send('rc:signal', { event, payload }),
  input: (payload: any) => ipcRenderer.send('rc:input', payload),
})
