// REST handshake, mirroring the desktop/Android-app login: POST /api/auth/login
// returns the JWT + the Socket.IO endpoint to connect to.

export function normalizeServerUrl(raw: string): string {
  let value = String(raw || '').trim()
  if (!value) throw new Error('服务器地址为空')
  if (!/^https?:\/\//i.test(value)) value = 'http://' + value
  const url = new URL(value)
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
  return url.href.replace(/\/$/, '')
}

export interface LoginResult {
  accessToken: string
  agentSocketUrl: string
  userId: number | null
  userName: string
}

export async function login(serverUrl: string, account: string, password: string): Promise<LoginResult> {
  const base = normalizeServerUrl(serverUrl)
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password }),
  })
  const text = await res.text()
  let data: any = {}
  if (text) { try { data = JSON.parse(text) } catch { data = { detail: text } } }
  if (!res.ok) throw new Error(data?.detail || data?.error || `登录失败 (${res.status})`)
  const token = String(data.access_token || '')
  if (!token) throw new Error('登录响应缺少 access_token')
  return {
    accessToken: token,
    agentSocketUrl: normalizeServerUrl(String(data.agent_socket_url || base)),
    userId: data.user?.id ?? null,
    userName: String(data.user?.name || data.user?.nickname || account),
  }
}
