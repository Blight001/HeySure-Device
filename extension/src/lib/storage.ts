import { AgentSettings, SETTING_DEFAULTS } from './types'

export async function getSettings(): Promise<AgentSettings> {
  const keys = Object.keys(SETTING_DEFAULTS)
  const stored = await chrome.storage.local.get(keys)
  return { ...SETTING_DEFAULTS, ...stored } as AgentSettings
}

export async function saveSettings(partial: Partial<AgentSettings>): Promise<void> {
  await chrome.storage.local.set(partial as any)
}

// Persist a small buffer of recent activity so the popup shows history on open
const ACT_KEY = '_activity_buffer'
const MAX_ACT = 100

export async function pushActivity(entry: any): Promise<void> {
  const r = await chrome.storage.session.get(ACT_KEY).catch(() => ({}))
  const buf: any[] = (r as any)[ACT_KEY] || []
  buf.push(entry)
  if (buf.length > MAX_ACT) buf.splice(0, buf.length - MAX_ACT)
  await chrome.storage.session.set({ [ACT_KEY]: buf }).catch(() => {})
}

export async function getActivity(): Promise<any[]> {
  const r = await chrome.storage.session.get(ACT_KEY).catch(() => ({}))
  return (r as any)[ACT_KEY] || []
}

// ── Software-end auth state (logged-in account mode) ─────────────────────────
export interface AuthState {
  token:    string
  account:  string
  password: string
  rememberLogin: boolean
  userId:   number | null
  userName: string
  avatar:   string
}

const AUTH_KEY = '_auth_state'
const AUTH_DEFAULT: AuthState = {
  token: '',
  account: '',
  password: '',
  rememberLogin: false,
  userId: null,
  userName: '',
  avatar: '',
}

export async function getAuth(): Promise<AuthState> {
  const r = await chrome.storage.local.get(AUTH_KEY)
  return { ...AUTH_DEFAULT, ...(r[AUTH_KEY] || {}) } as AuthState
}

export async function saveAuth(state: Partial<AuthState>): Promise<void> {
  const current = await getAuth()
  await chrome.storage.local.set({ [AUTH_KEY]: { ...current, ...state } })
}

export async function clearAuth(): Promise<void> {
  const current = await getAuth()
  const remembered = !!current.rememberLogin
  await chrome.storage.local.set({
    [AUTH_KEY]: {
      ...AUTH_DEFAULT,
      account: remembered ? current.account : '',
      password: remembered ? current.password : '',
      rememberLogin: remembered,
    },
  })
}

// ── Avatar cache (current account only) ──────────────────────────────────────
// The avatar image is fetched from the server once and cached as a data URL so
// it renders instantly on popup open without re-downloading. Only the current
// account's avatar is kept; `src` records which source URL the data belongs to
// so a different/changed avatar (e.g. after switching accounts) re-fetches.
export interface AvatarCache { src: string; dataUrl: string }
const AVATAR_CACHE_KEY = '_avatar_cache'

export async function getAvatarCache(): Promise<AvatarCache | null> {
  const r = await chrome.storage.local.get(AVATAR_CACHE_KEY)
  const c = (r as any)[AVATAR_CACHE_KEY]
  return c && typeof c.src === 'string' && typeof c.dataUrl === 'string' ? c as AvatarCache : null
}

export async function setAvatarCache(cache: AvatarCache): Promise<void> {
  await chrome.storage.local.set({ [AVATAR_CACHE_KEY]: cache })
}

export async function clearAvatarCache(): Promise<void> {
  await chrome.storage.local.remove(AVATAR_CACHE_KEY)
}

// ── MCP tool description overrides (local edits, fallback tools only) ─────────
// Popup edits apply only while the server has not yet pushed a workspace copy
// of the tool. Server-managed tools (device:tool-config) use workspace files
// as the schema source of truth — same model as the Windows desktop agent.
export interface ToolDescOverride {
  description?: string
  // paramName -> description
  parameters?: Record<string, string>
}
const TOOL_DESC_KEY = '_tool_desc_overrides'

export async function getToolDescOverrides(): Promise<Record<string, ToolDescOverride>> {
  const r = await chrome.storage.local.get(TOOL_DESC_KEY)
  const v = (r as any)[TOOL_DESC_KEY]
  return v && typeof v === 'object' ? v as Record<string, ToolDescOverride> : {}
}

export async function setToolDescOverride(tool: string, override: ToolDescOverride): Promise<void> {
  const all = await getToolDescOverrides()
  const name = String(tool || '').trim()
  if (!name) return
  const desc = String(override.description || '').trim()
  const params: Record<string, string> = {}
  for (const [k, v] of Object.entries(override.parameters || {})) {
    const pn = String(k || '').trim()
    const pv = String(v || '').trim()
    if (pn && pv) params[pn] = pv
  }
  if (!desc && Object.keys(params).length === 0) {
    delete all[name]
  } else {
    all[name] = { description: desc, parameters: params }
  }
  await chrome.storage.local.set({ [TOOL_DESC_KEY]: all })
}

export async function clearToolDescOverrides(names: string[]): Promise<void> {
  const all = await getToolDescOverrides()
  let changed = false
  for (const raw of names) {
    const name = String(raw || '').trim()
    if (name && all[name]) {
      delete all[name]
      changed = true
    }
  }
  if (changed) await chrome.storage.local.set({ [TOOL_DESC_KEY]: all })
}

// ── MCP tool enable/disable selection ────────────────────────────────────────
// Each browser tool can be toggled on/off in the popup's MCP page. Only enabled
// tools are reported to the server (capabilities + toolDefs), so unchecked tools
// become invisible to the server and the AI. This map stores the user's explicit
// choices keyed by tool name; tools absent from the map fall back to the global
// default enabled state.
const TOOL_ENABLED_KEY = '_tool_enabled'

export async function getToolEnabledMap(): Promise<Record<string, boolean>> {
  const r = await chrome.storage.local.get(TOOL_ENABLED_KEY)
  const v = (r as any)[TOOL_ENABLED_KEY]
  return v && typeof v === 'object' ? v as Record<string, boolean> : {}
}

export async function setToolEnabled(tool: string, enabled: boolean): Promise<void> {
  const all = await getToolEnabledMap()
  const name = String(tool || '').trim()
  if (!name) return
  all[name] = !!enabled
  await chrome.storage.local.set({ [TOOL_ENABLED_KEY]: all })
}

export async function setManyToolEnabled(tools: string[], enabled: boolean): Promise<void> {
  const all = await getToolEnabledMap()
  for (const t of tools) {
    const name = String(t || '').trim()
    if (name) all[name] = !!enabled
  }
  await chrome.storage.local.set({ [TOOL_ENABLED_KEY]: all })
}

