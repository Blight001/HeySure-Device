import Store from 'electron-store'

interface AgentSettings {
  serverUrl: string
  agentSocketUrl: string
  agentToken: string
  deviceId: string
  agentName: string
  agentGroup: string
  workspaceRoot: string
  autoStart: boolean
  theme: 'dark' | 'light'
  windowBounds: { x: number; y: number; width: number; height: number } | null
  aiKey: string
  aiBaseUrl: string
  aiModel: string
  // Auth
  userAccount: string
  userPassword: string
  rememberLogin: boolean
  userName: string
  userAvatar: string
  // Cached data URL of the current account's avatar (fetched from the backend),
  // so it renders instantly and offline. Empty = fall back to the live URL.
  userAvatarDataUrl: string
  authToken: string
  userId: number | null
  // Selected AI Config
  selectedAiConfigId: number | null
  selectedAiConfigName: string
  selectedAiConfigRole: string
  selectedAiConfigLifecycle: string
  selectedAiConfigProject: string
  // Mouse-effect toggle (simulated cursor on AI operations), parity with the
  // browser extension's setting.
  mouseFx: boolean
  // Mouse coordinate calibration. Input coordinates are screenshot pixels.
  mouseCoordinateScaleX: number
  mouseCoordinateScaleY: number
  mouseCoordinateOffsetX: number
  mouseCoordinateOffsetY: number
  // Legacy flag from the old offline mode. Kept for config compatibility only;
  // local chat no longer changes the server connection lifecycle.
  offlineMode: boolean
  offlinePrompt: string
  // Local per-tool description edits, merged onto getToolDefs() before they are
  // reported to the server via device:register -> toolDefs. Keyed by tool id.
  // { [toolId]: { description?: string; parameters?: { [param]: string } } }
  toolDescOverrides: Record<string, { description?: string; parameters?: Record<string, string> }>
  // Local MCP exposure switches. Missing = enabled for backward compatibility.
  toolEnabled: Record<string, boolean>
}

const defaults: AgentSettings = {
  serverUrl: process.env.SERVER_URL || 'http://127.0.0.1:3000',
  agentSocketUrl: '',
  agentToken: process.env.AGENT_TOKEN || '',
  deviceId: process.env.AGENT_ID || '',
  agentName: process.env.AGENT_NAME || 'Windows Agent',
  agentGroup: process.env.AGENT_GROUP || '',
  workspaceRoot: process.env.WORKSPACE_ROOT || '',
  autoStart: false,
  theme: 'dark',
  windowBounds: null,
  aiKey: process.env.AI_KEY || '',
  aiBaseUrl: process.env.AI_BASE_URL || 'https://api.anthropic.com',
  aiModel: process.env.AI_MODEL || 'claude-sonnet-4-5',
  userAccount: '',
  userPassword: '',
  rememberLogin: false,
  userName: '',
  userAvatar: '',
  userAvatarDataUrl: '',
  authToken: '',
  userId: null,
  selectedAiConfigId: null,
  selectedAiConfigName: '',
  selectedAiConfigRole: 'member',
  selectedAiConfigLifecycle: 'working',
  selectedAiConfigProject: '',
  mouseFx: true,
  mouseCoordinateScaleX: 1,
  mouseCoordinateScaleY: 1,
  mouseCoordinateOffsetX: 0,
  mouseCoordinateOffsetY: 0,
  offlineMode: false,
  offlinePrompt: '你是 HeySure AI，运行在 Windows 桌面端的本地对话窗口中。你可以直接回答用户，也可以调用本机 MCP 工具完成文件、窗口、键鼠、剪贴板、终端等桌面任务。需要操作电脑时优先使用工具，并用和用户相同的语言回复。',
  toolDescOverrides: {},
  toolEnabled: {},
}

export const store = new Store<AgentSettings>({ defaults })
export type { AgentSettings }
