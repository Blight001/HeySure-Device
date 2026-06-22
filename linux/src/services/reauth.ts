// Silent re-authentication using the credentials the user chose to remember.
//
// The server is updated/restarted frequently. When that happens the user JWT
// we registered with can expire or be rejected, which previously dropped the
// agent offline until someone logged in by hand. If the user ticked
// "remember", we keep the account + password in the store, so we can quietly
// fetch a fresh token and bring the connection back without any interaction.

import { store } from '../store'
import { resolveAgentSocketUrl, resolveBaseUrl, serverFetch } from './server-client'
import { cacheUserAvatar } from './avatar-cache'

// De-dupe concurrent callers: a burst of 401s (or a register rejection racing
// with an in-flight request) should only trigger a single login round-trip.
let inFlight: Promise<boolean> | null = null

function hasSavedCredentials(): boolean {
  return (
    !!store.get('rememberLogin') &&
    !!String(store.get('userAccount') || '').trim() &&
    !!String(store.get('userPassword') || '').trim()
  )
}

// Attempt a silent re-login with the saved credentials. Returns true and
// persists a fresh authToken on success; returns false (without touching the
// stored session) when there are no saved credentials or the login fails.
export async function reauthenticate(): Promise<boolean> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    if (!hasSavedCredentials()) return false

    const account = String(store.get('userAccount') || '').trim()
    const password = String(store.get('userPassword') || '')
    let base: string
    try {
      base = resolveBaseUrl(String(store.get('serverUrl') || ''))
    } catch {
      return false
    }

    try {
      // No token is sent for the login call, so a wrong-password 401 here is
      // surfaced as a normal failure and does NOT recurse into session clearing.
      const data = await serverFetch<any>(base, '/api/auth/login', {
        method: 'POST',
        body: { account, password },
        failureMessage: '自动重新登录失败',
        timeoutMs: 15_000,
      })
      if (!data?.access_token) return false
      const agentSocketUrl = resolveAgentSocketUrl(String(data.agent_socket_url || ''))
      if (!agentSocketUrl) return false

      store.set('serverUrl', base)
      store.set('agentSocketUrl', agentSocketUrl)
      store.set('authToken', data.access_token)
      store.set('userName', String(data.user?.name || data.user?.nickname || account))
      store.set('userAvatar', String(data.user?.avatar || ''))
      store.set('userId', data.user?.id ?? null)
      try {
        await cacheUserAvatar(base, String(data.user?.avatar || ''))
      } catch {
        /* avatar is best-effort */
      }
      return true
    } catch {
      return false
    }
  })()

  try {
    return await inFlight
  } finally {
    inFlight = null
  }
}
