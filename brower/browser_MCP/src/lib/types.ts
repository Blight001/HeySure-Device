export type DeviceStatus = 'disconnected' | 'connecting' | 'connected' | 'registered' | 'error'

export interface AgentSettings {
  serverUrl:    string
  agentSocketUrl: string
  agentToken:   string
  deviceId:      string
  agentName:    string
  agentGroup:   string
  aiKey:        string
  aiBaseUrl:    string
  aiModel:      string
  offlineMode:  boolean
  offlinePrompt: string
  mouseFx:      boolean
  theme:        'dark' | 'light'
  selectedAiConfigId: number | null
}

export const SETTING_DEFAULTS: AgentSettings = {
  serverUrl:   'http://localhost:3000',
  agentSocketUrl: '',
  agentToken:  '',
  deviceId:     '',
  agentName:   '浏览器插件',
  agentGroup:  '',
  aiKey:       '',
  aiBaseUrl:   'https://api.anthropic.com',
  aiModel:     'claude-sonnet-4-5',
  offlineMode: false,
  offlinePrompt: '你是 HeySure AI，运行在浏览器插件的本地对话窗口中。你可以直接回答用户，也可以调用本机浏览器 MCP 工具完成网页浏览、点击、输入、截图、提取数据、管理标签页等任务。需要操作浏览器时优先使用工具，并用和用户相同的语言回复。',
  mouseFx:     true,
  theme:       'dark',
  selectedAiConfigId: null,
}

export interface DispatchedTask {
  taskId:      string
  userId?:     string | number
  aiConfigId?: string | number
  sessionId?:  string
  instruction?: string
  tool?:       string
  args?:       Record<string, any>
  allowedTools?: string[]
}

export interface TaskResult {
  success: boolean
  tool:    string
  result:  any
  summary: string
}

export interface ActivityEntry {
  id:        string
  type:      string
  status:    string
  message:   string
  data?:     any
  timestamp: number
}

// ── AI types ──────────────────────────────────────────────────────────────
export interface ChatMessage {
  role:    'user' | 'assistant' | 'system'
  content: string | any[]  // string for simple text, array for tool-use/tool-result blocks
  // Optional fields populated when the message lives on the server.
  serverId?:   number
  think?:      string
  createdAt?:  number
}

export interface AIToolDef {
  name:         string
  description:  string
  input_schema: { type: 'object'; properties: Record<string, any>; required?: string[] }
  implementation?: Record<string, any>
}

export interface AIToolUse {
  type:  'tool_use'
  id:    string
  name:  string
  input: Record<string, any>
}

export interface ChatToolEvent {
  key: string
  label: string
  detail?: string
  imageUrl?: string
}

export interface OfflineChatToolEvent {
  tool: string
  arguments: Record<string, any>
  success: boolean
  result: any
  summary: string
}

// ── Popup <-> Background messages ────────────────────────────────────────
export type PopupMsg =
  | { type: 'device:connect' }
  | { type: 'device:disconnect' }
  | { type: 'auth:logout' }
  | { type: 'settings:get' }
  | { type: 'settings:save'; payload: Partial<AgentSettings> }
  | { type: 'agent:selected-ai'; aiConfigId: number | null }
  | { type: 'chat:send'; messages: ChatMessage[]; requestId?: string }
  | { type: 'offline-chat:get-config'; requestId: string }
  | { type: 'offline-chat:save-model'; requestId: string; payload: Pick<AgentSettings, 'aiKey' | 'aiBaseUrl' | 'aiModel'> }
  | { type: 'offline-chat:save-prompt'; requestId: string; prompt: string }
  | { type: 'offline-chat:list-tools'; requestId: string }
  | { type: 'offline-chat:send'; requestId: string; messages: ChatMessage[]; prompt?: string; allowedTools?: string[] }
  | { type: 'offline-chat:cancel'; requestId: string }
  | { type: 'connection:test' }
  // MCP tool tester: run one local browser tool and return its raw result.
  | { type: 'mcp:test'; requestId: string; tool: string; args: Record<string, any> }

export type BgMsg =
  | { type: 'device:status';    status: DeviceStatus; reason?: string; aiConfigId?: number | null }
  | { type: 'activity:log';    entry: ActivityEntry }
  | { type: 'task:start';      data: any }
  | { type: 'task:result';     data: any }
  | { type: 'settings:data';   settings: AgentSettings }
  | { type: 'chat:response';   text: string; toolsUsed?: string[]; toolEvents?: ChatToolEvent[]; requestId?: string }
  | { type: 'chat:error';      error: string; requestId?: string }
  | { type: 'offline-chat:config'; requestId: string; settings: AgentSettings; hasAiKey: boolean }
  | { type: 'offline-chat:model-saved'; requestId: string; ok: boolean; settings?: AgentSettings; error?: string }
  | { type: 'offline-chat:prompt-saved'; requestId: string; ok: boolean }
  | { type: 'offline-chat:tools'; requestId: string; tools: AIToolDef[] }
  | { type: 'offline-chat:progress'; requestId: string; event: any }
  | { type: 'offline-chat:response'; requestId: string; text: string; toolsUsed: string[]; toolEvents: OfflineChatToolEvent[]; usage?: { inputTokens: number; outputTokens: number; totalTokens: number; estimated?: boolean } }
  | { type: 'offline-chat:error'; requestId: string; error: string }
  | { type: 'offline-chat:canceled'; requestId: string; ok: boolean }
  | { type: 'connection:result'; result: any }
  | { type: 'mcp:test:result'; requestId: string; ok: boolean; result?: any; error?: string }
