// Thin wrapper around Electron's `net.fetch` for talking to the HeySure server.
// Centralizes URL normalization, auth header injection, timeout, and error
// extraction so the IPC handlers don't each reinvent it.

import { net } from 'electron'
import { normalizeServerUrl } from '../server-url'
import type { AgentSettings } from '../store'
import { recoverAuthSession } from './auth-state'

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

export function resolveAgentSocketUrl(rawUrl: string): string {
  return normalizeServerUrl(rawUrl)
}

// Variant that requires an authenticated session (throws if missing).
export function requireAuth(settings: AgentSettings): { base: string; token: string } {
  if (!settings.serverUrl || !settings.authToken) throw new Error('未登录')
  return { base: resolveBaseUrl(settings.serverUrl), token: settings.authToken }
}

async function readJson(res: Response, fallback: string, wasAuthenticated = false): Promise<any> {
  const text = await res.text()
  let data: any = {}
  if (text) {
    try { data = JSON.parse(text) } catch { data = { detail: text } }
  }
  if (!res.ok) {
    const message = res.status === 401 && wasAuthenticated
      ? '登录已过期，请重新登录'
      : data?.detail || data?.error || `${fallback} (${res.status})`
    if (res.status === 401 && wasAuthenticated) {
      // Our token went stale (commonly after a server update). Try to recover
      // the session in the background by re-logging in with the saved
      // credentials; only if that fails does it clear the session and prompt a
      // manual login. Fire-and-forget — this request still fails as 401.
      void recoverAuthSession()
    }
    throw new ServerError(
      message,
      res.status,
      data,
    )
  }
  return data
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

  const res = await net.fetch(`${base}${pathname}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs || DEFAULT_TIMEOUT_MS),
  })

  return readJson(res, opts.failureMessage || `请求失败`, !!opts.token)
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
export async function fetchIceServers(base: string, token: string): Promise<IceServer[]> {
  try {
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

export async function fetchAgentEndpoint(base: string, token: string): Promise<string> {
  const data = await serverFetch<{ agent_socket_url?: string }>(base, '/api/auth/agent-endpoint', {
    token,
    failureMessage: '获取 Agent 连接地址失败',
  })
  const url = resolveAgentSocketUrl(String(data.agent_socket_url || ''))
  if (!url) throw new Error('服务器未返回 Agent 连接地址')
  return url
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
    const res = await net.fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) })
      .catch(() => net.fetch(base, { signal: AbortSignal.timeout(5000) }))
    return { success: true, status: res.status, ms: Date.now() - start }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}
