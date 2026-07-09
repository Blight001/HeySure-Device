// client.ts — HeySure software-end HTTP client (logged-in account mode)
// Talks to the same REST auth API the web dashboard uses. The extension UI
// currently only needs login + identity; the previously-present chat/task/MCP
// client calls were unused and removed (recover from git history if the popup
// is ever wired up to drive chat runs / tasks directly).
// All calls require a server URL plus a bearer token obtained from login().

export interface LoginUser {
  id:       number
  name:     string
  account:  string
  avatar?:  string
  [k: string]: any
}

export interface MemberConfig {
  id:                  number
  name:                string
  description?:        string
  model?:              string
  ai_role?:            string            // assistant_admin / digital_member
  digital_member_role?: string           // manager / member
  platform?:           string
  token_limit?:        number
  enabled?:            boolean
  mcp_enabled?:        boolean
  mcp_tools?:          string             // JSON array string
  workspace_root?:     string | null
  current_behavior?:   string
  project_name?:       string | null
  [k: string]: any
}

const trimUrl = (u: string) => String(u || '').replace(/\/+$/, '')

const authHeaders = (token: string, withJson = false): Record<string, string> => {
  const h: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (withJson) h['Content-Type'] = 'application/json'
  return h
}

// Error that carries the HTTP status so callers can reliably tell an
// auth failure (401/403 → token expired/invalid) apart from a transient
// network/timeout error. Relying on message-string matching alone is
// fragile because the server's `detail` text isn't guaranteed to contain
// any particular keyword.
export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

// True only for authentication/authorization failures. A thrown TypeError
// (fetch network failure) or AbortError (timeout) is NOT an auth error and
// must not trigger a logout.
export function isAuthError(err: any): boolean {
  if (err && typeof err.status === 'number') return err.status === 401 || err.status === 403
  return /\b(401|403)\b|令牌|凭证|credential|unauthor/i.test(String(err?.message || err))
}

async function parseError(res: Response, fallback: string): Promise<string> {
  try {
    const data: any = await res.json()
    return String(data?.detail || data?.error || fallback)
  } catch {
    return `${fallback} (HTTP ${res.status})`
  }
}

async function requestJson<T>(url: string, init: RequestInit, fallback: string): Promise<T> {
  const res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(20000) })
  if (!res.ok) throw new ApiError(await parseError(res, fallback), res.status)
  return await res.json() as T
}

// ── Auth ────────────────────────────────────────────────────────────────────
export async function login(serverUrl: string, account: string, password: string): Promise<{ token: string; user: LoginUser; agentSocketUrl: string }> {
  const base = trimUrl(serverUrl)
  const data = await requestJson<{ access_token: string; user: LoginUser; agent_socket_url?: string }>(
    `${base}/api/auth/login`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account, password }) },
    '登录失败',
  )
  if (!data.access_token) throw new Error('登录响应缺少令牌')
  const agentSocketUrl = trimUrl(data.agent_socket_url || '')
  if (!agentSocketUrl) throw new Error('登录响应缺少 Agent 连接地址')
  return { token: data.access_token, user: data.user, agentSocketUrl }
}

export async function getMe(serverUrl: string, token: string): Promise<LoginUser> {
  return requestJson<LoginUser>(`${trimUrl(serverUrl)}/api/auth/me`, { headers: authHeaders(token) }, '获取用户信息失败')
}

export async function getAgentEndpoint(serverUrl: string, token: string): Promise<string> {
  const data = await requestJson<{ agent_socket_url?: string }>(
    `${trimUrl(serverUrl)}/api/auth/agent-endpoint`,
    { headers: authHeaders(token) },
    '获取 Agent 连接地址失败',
  )
  const agentSocketUrl = trimUrl(data.agent_socket_url || '')
  if (!agentSocketUrl) throw new Error('服务器未返回 Agent 连接地址')
  return agentSocketUrl
}

/** WebRTC ICE server entry (STUN or TURN) as delivered by the server. */
export interface IceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

// Historical default so remote control still works if the server is old or
// unreachable (STUN-only — no relay for symmetric NAT).
export const DEFAULT_ICE_SERVERS: IceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

/**
 * Resolve the server-configured ICE servers (STUN + optional TURN) for remote
 * control. Never throws — falls back to {@link DEFAULT_ICE_SERVERS}.
 */
export async function getIceServers(serverUrl: string, token: string): Promise<IceServer[]> {
  try {
    const data = await requestJson<{ ice_servers?: IceServer[] }>(
      `${trimUrl(serverUrl)}/api/rtc/ice-servers`,
      { headers: authHeaders(token) },
      '获取 ICE 服务器配置失败',
    )
    const list = Array.isArray(data.ice_servers) ? data.ice_servers : []
    return list.length ? list : DEFAULT_ICE_SERVERS
  } catch {
    return DEFAULT_ICE_SERVERS
  }
}
