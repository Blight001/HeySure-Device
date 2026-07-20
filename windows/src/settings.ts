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
  browserBridgeEnabled: boolean
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
  // (toolEnabled removed: MCPs are server-issued; no local allow-call checkboxes)
  // 开机自启默认关闭；用户可在设置页手动启用。
  autoStart: boolean
}

const SETTINGS_FILE = 'settings.json'

export const defaults: AgentSettings = {
  serverUrl: 'http://127.0.0.1:3000',
  agentSocketUrl: '',
  agentToken: '',
  deviceId: '',
  agentName: 'Windows设备',
  agentGroup: '',
  workspaceRoot: '',
  theme: 'dark',
  aiKey: '',
  aiBaseUrl: 'https://api.anthropic.com',
  aiModel: 'claude-sonnet-4-5',
  mouseFx: true,
  mouseCoordinateScaleX: 1,
  mouseCoordinateScaleY: 1,
  browserBridgeEnabled: true,
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
  autoStart: false,
}

export async function loadSettings(): Promise<AgentSettings> {
  try {
    const raw = await native.loadJsonFile(SETTINGS_FILE)
    if (raw && typeof raw === 'object') {
      const loaded = { ...defaults, ...raw } as AgentSettings
      // These were product defaults, not user-chosen names. Existing installs
      // persist them in settings.json, so changing only ``defaults`` would keep
      // reporting the obsolete Tauri prototype label forever.
      if (['Windows Agent (Tauri)', 'Windows 桌面'].includes(String(loaded.agentName || '').trim())) {
        loaded.agentName = defaults.agentName
        try {
          await native.saveJsonFile(SETTINGS_FILE, loaded)
        } catch (err) {
          // Keep the successfully loaded login/settings in memory even if this
          // one-time cosmetic migration cannot be persisted yet.
          console.error('persist agent-name migration failed:', err)
        }
      }
      return loaded
    }
  } catch (err) {
    console.error('loadSettings failed:', err)
  }
  return { ...defaults }
}

export async function saveSettings(settings: AgentSettings): Promise<void> {
  await native.saveJsonFile(SETTINGS_FILE, settings)
}

// A stable per-install id is what lets the server tell two physically
// different machines apart in the Workshop panel. Falling back to the
// hostname (as this used to) collides whenever two machines share one (cloned
// images, factory default names), so generate a random id once and persist it
// — subsequent boots reuse the saved value instead of regenerating it.
export async function ensureDeviceId(settings: AgentSettings): Promise<string> {
  if (settings.deviceId) return settings.deviceId
  const id = 'win-' + (typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)
  settings.deviceId = id
  await saveSettings(settings)
  return id
}
