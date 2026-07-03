// settings — replaces electron-store. The subset of device/windows/src/store.ts
// the phase-1 prototype needs. Remote-control/screenshot execution is still
// out of scope, but its user-facing switches are preserved so the UI matches
// the Electron shell and settings can survive a later migration.

import { native } from './native'

export interface AgentSettings {
  serverUrl: string
  agentSocketUrl: string
  agentToken: string
  deviceId: string
  agentName: string
  agentGroup: string
  workspaceRoot: string
  theme: 'dark' | 'light'
  aiKey: string
  aiBaseUrl: string
  aiModel: string
  mouseFx: boolean
  mouseCoordinateScaleX: number
  mouseCoordinateScaleY: number
  offlinePrompt: string
  // Auth
  userAccount: string
  userPassword: string
  rememberLogin: boolean
  userName: string
  userAvatar: string
  userAvatarDataUrl: string
  authToken: string
  userId: number | null
  // Local per-tool description edits, merged onto getToolDefs() before they are
  // reported to the server via device:register -> toolDefs. Keyed by tool id.
  toolDescOverrides: Record<string, { description?: string; parameters?: Record<string, string> }>
  // Local MCP exposure switches. Missing = enabled for backward compatibility.
  toolEnabled: Record<string, boolean>
}

const SETTINGS_FILE = 'settings.json'

export const defaults: AgentSettings = {
  serverUrl: 'http://127.0.0.1:3000',
  agentSocketUrl: '',
  agentToken: '',
  deviceId: '',
  agentName: 'Windows Agent (Tauri)',
  agentGroup: '',
  workspaceRoot: '',
  theme: 'dark',
  aiKey: '',
  aiBaseUrl: 'https://api.anthropic.com',
  aiModel: 'claude-sonnet-4-5',
  mouseFx: true,
  mouseCoordinateScaleX: 1,
  mouseCoordinateScaleY: 1,
  offlinePrompt: '你是 HeySure AI，运行在 Windows 桌面端的本地对话窗口中。你可以直接回答用户，也可以调用本机 MCP 工具完成文件、窗口、键鼠、剪贴板、终端等桌面任务。需要操作电脑时优先使用工具，并用和用户相同的语言回复。',
  userAccount: '',
  userPassword: '',
  rememberLogin: false,
  userName: '',
  userAvatar: '',
  userAvatarDataUrl: '',
  authToken: '',
  userId: null,
  toolDescOverrides: {},
  toolEnabled: {},
}

export async function loadSettings(): Promise<AgentSettings> {
  try {
    const raw = await native.loadJsonFile(SETTINGS_FILE)
    if (raw && typeof raw === 'object') return { ...defaults, ...raw }
  } catch (err) {
    console.error('loadSettings failed:', err)
  }
  return { ...defaults }
}

export async function saveSettings(settings: AgentSettings): Promise<void> {
  await native.saveJsonFile(SETTINGS_FILE, settings)
}
