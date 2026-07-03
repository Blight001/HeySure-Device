// api — REST calls to the HeySure gateway. The Electron version proxied these
// through the main process (net.fetch); the gateway allows all CORS origins,
// so the WebView calls it directly with plain fetch.

import { normalizeServerUrl } from './server-url'

const DEFAULT_TIMEOUT_MS = 10_000

export class ServerError extends Error {
  status: number
  detail?: any
  constructor(message: string, status: number, detail?: any) {
    super(message)
    this.status = status
    this.detail = detail
  }
}

export interface ServerRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: any
  token?: string | null
  timeoutMs?: number
  failureMessage?: string
}

export function resolveBaseUrl(rawUrl: string): string {
  return normalizeServerUrl(rawUrl)
}

export async function serverFetch<T = any>(
  base: string,
  pathname: string,
  opts: ServerRequestOptions = {},
): Promise<T> {
  const method = opts.method || 'GET'
  const headers: Record<string, string> = {}
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs || DEFAULT_TIMEOUT_MS),
  })

  const text = await res.text()
  let data: any = {}
  if (text) {
    try { data = JSON.parse(text) } catch { data = { detail: text } }
  }
  if (!res.ok) {
    const message = res.status === 401 && opts.token
      ? '登录已过期，请重新登录'
      : data?.detail || data?.error || `${opts.failureMessage || '请求失败'} (${res.status})`
    throw new ServerError(message, res.status, data)
  }
  return data
}

export interface LoginResult {
  accessToken: string
  agentSocketUrl: string
  user: { id?: number; name?: string; nickname?: string; avatar?: string }
}

export async function login(serverUrl: string, account: string, password: string): Promise<LoginResult> {
  if (!serverUrl) throw new Error('服务器 URL 不能为空')
  let base: string
  try { base = resolveBaseUrl(serverUrl) } catch { throw new Error('服务器 URL 格式无效') }

  const data = await serverFetch<any>(base, '/api/auth/login', {
    method: 'POST',
    body: { account, password },
    failureMessage: '登录失败',
  })

  const agentSocketUrl = normalizeServerUrl(String(data.agent_socket_url || ''))
  if (!agentSocketUrl) throw new Error('登录响应缺少 Agent 连接地址')
  return {
    accessToken: String(data.access_token || ''),
    agentSocketUrl,
    user: data.user || {},
  }
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
 * control. Never throws — falls back to {@link DEFAULT_ICE_SERVERS} so a
 * signaling hiccup can't block a session.
 */
export async function fetchIceServers(serverUrl: string, token: string): Promise<IceServer[]> {
  try {
    const base = resolveBaseUrl(serverUrl)
    if (!base || !token) return DEFAULT_ICE_SERVERS
    const data = await serverFetch<{ ice_servers?: IceServer[] }>(base, '/api/rtc/ice-servers', {
      token,
      failureMessage: '获取 ICE 服务器配置失败',
    })
    const list = Array.isArray(data.ice_servers) ? data.ice_servers : []
    return list.length ? list : DEFAULT_ICE_SERVERS
  } catch {
    return DEFAULT_ICE_SERVERS
  }
}

// Health-probe used by the "test connection" button. Falls back to the root
// path if /health is not implemented and returns latency in ms.
export async function pingServer(rawUrl: string): Promise<{ success: true; status: number; ms: number } | { success: false; error: string }> {
  const value = String(rawUrl || '').trim()
  if (!value) return { success: false, error: '未配置服务器 URL' }
  let base: string
  try { base = resolveBaseUrl(value) } catch { return { success: false, error: '服务器 URL 格式无效' } }
  try {
    const start = Date.now()
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) })
      .catch(() => fetch(base, { signal: AbortSignal.timeout(5000) }))
    return { success: true, status: res.status, ms: Date.now() - start }
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) }
  }
}

// Fetch current logged-in user profile (used to keep avatar/name in sync if changed on web console).
export async function getMe(serverUrl: string, token: string): Promise<any> {
  let base: string
  try { base = resolveBaseUrl(serverUrl) } catch { throw new Error('服务器 URL 格式无效') }
  return serverFetch<any>(base, '/api/auth/me', {
    token,
    failureMessage: '获取用户信息失败',
  })
}
