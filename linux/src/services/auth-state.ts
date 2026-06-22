import { store } from '../store'
import { clearSelectedAiConfig, getAgent, rebuildAgent } from './device-runtime'
import { sendActivityLog } from './activity-log'
import { getMainWindow } from '../windows/main-window'
import { reauthenticate } from './reauth'

export function clearStoredAuthSession(reason = '登录已过期，请重新登录'): void {
  const hadAuth = !!store.get('authToken')

  getAgent()?.disconnect()
  store.set('authToken', '')
  store.set('agentSocketUrl', '')
  store.set('userAccount', '')
  store.set('userName', '')
  store.set('userAvatar', '')
  store.set('userAvatarDataUrl', '')
  store.set('userId', null)
  clearSelectedAiConfig()
  rebuildAgent(store.store)

  if (hadAuth) {
    sendActivityLog('system', 'warn', reason)
    getMainWindow()?.webContents.send('auth:expired', reason)
  }
}

// Throttle so a server that keeps rejecting us can't spin the auto-login in a
// tight loop. After a few attempts in a short window we give up and fall back
// to asking the user to log in by hand.
const REAUTH_WINDOW_MS = 60_000
const REAUTH_MAX_IN_WINDOW = 3
let reauthTimestamps: number[] = []
let recovering: Promise<boolean> | null = null

// Called when the server reports our session is no longer valid — an HTTP 401
// or a socket-level register rejection. First we try to silently re-login with
// the saved credentials and bring the agent back online; only if that fails do
// we clear the session and prompt the user. Concurrent callers share a single
// recovery attempt. Returns true if the session was recovered.
export function recoverAuthSession(reason = '登录已过期，请重新登录'): Promise<boolean> {
  if (recovering) return recovering
  recovering = (async () => {
    const now = Date.now()
    reauthTimestamps = reauthTimestamps.filter(t => now - t < REAUTH_WINDOW_MS)
    if (reauthTimestamps.length >= REAUTH_MAX_IN_WINDOW) {
      sendActivityLog('system', 'warn', '自动重新登录尝试过于频繁，已停止并要求手动登录')
      clearStoredAuthSession(reason)
      return false
    }
    reauthTimestamps.push(now)

    sendActivityLog('system', 'info', `检测到登录失效（${reason}），正在用保存的账号自动重新登录…`)
    // Show the orange "reconnecting" prompt while we re-login + reconnect. It is
    // cleared when the agent registers again, or by auth:expired if we give up.
    getMainWindow()?.webContents.send('device:reconnecting', true, '登录已失效，正在自动重新登录…')
    const ok = await reauthenticate()
    if (ok) {
      // Fresh token in the store — rebuild the agent so it picks up the new
      // token, then reconnect. rebuildAgent tears down the old (possibly still
      // transport-connected) socket first.
      sendActivityLog('system', 'success', '自动重新登录成功，正在重新连接服务器')
      rebuildAgent(store.store)
      getAgent()?.connect()
      getMainWindow()?.webContents.send('auth:refreshed')
      return true
    }

    clearStoredAuthSession(reason)
    return false
  })()

  // Release the lock once this attempt settles so a later, genuinely new
  // failure can try again.
  recovering.finally(() => { recovering = null })
  return recovering
}
