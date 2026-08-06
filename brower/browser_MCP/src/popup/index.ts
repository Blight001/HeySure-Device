// popup/index.ts — HeySure Agent popup entry / orchestrator.
// The popup's main area is the browser MCP tool page. A logged-in account, the
// connection status indicator and settings are surfaced through header controls
// and modals. This file owns the background port dispatch, startup flow and
// listener wiring.

import { BgMsg } from '../lib/types'
import { state } from './state'
import * as dom from './dom'
import { getAuth, saveAuth, getSettings, saveSettings } from '../lib/storage'
import { getAgentEndpoint, getMe, isAuthError } from '../lib/client'
import { refreshAvatarCache } from './helpers'
import { initPopupPort, sendToBackground } from './transport'
import {
  setStatus, setBoundAi, updateUserChip, updateOfflineUi, renderStats, wireUi,
} from './ui'
import { doLogout, wireMembers } from './members'
import { loadSettings, wireSettings } from './settings'
import { renderMcpList, wireMcp, resolveTest } from './mcp'

// ── Port & background messages ────────────────────────────────────────────
function handleBackgroundMessage(msg: BgMsg) {
  switch (msg.type) {
    case 'device:status':
      setStatus(msg.status)
      if (typeof msg.aiConfigId !== 'undefined') setBoundAi(msg.aiConfigId ?? null)
      break
    case 'task:start':
      state.stats.total += 1
      state.stats.running += 1
      renderStats()
      break
    case 'task:result':
      state.stats.running = Math.max(0, state.stats.running - 1)
      if (msg.data?.success) state.stats.success += 1
      else state.stats.failed += 1
      renderStats()
      break
    case 'settings:data':
      loadSettings(msg.settings)
      break
    case 'mcp:test:result':
      resolveTest(msg.requestId, { ok: msg.ok, result: msg.result, error: msg.error })
      break
  }
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  initPopupPort(handleBackgroundMessage)
  sendToBackground({ type: 'settings:get' })
  renderStats()
  void renderMcpList()
  const s = await getSettings()
  state.serverUrl = s.serverUrl || ''
  state.offlineMode = !!s.offlineMode
  state.localModel = s.aiModel || ''
  state.auth = await getAuth()
  dom.loginAccount.value = state.auth.account || ''
  dom.loginPassword.value = state.auth.password || ''
  dom.loginRemember.checked = !!state.auth.rememberLogin
  updateUserChip()
  updateOfflineUi()
  void refreshAvatarCache().then(updateUserChip)
  if (state.auth.token) {
    void (async () => {
      try {
        const me = await getMe(state.serverUrl, state.auth.token)
        const agentSocketUrl = await getAgentEndpoint(state.serverUrl, state.auth.token)
        state.auth.userName = me?.name || state.auth.userName
        state.auth.avatar = me?.avatar || ''
        await saveAuth({ userName: state.auth.userName, avatar: state.auth.avatar })
        await saveSettings({ agentSocketUrl })
        await refreshAvatarCache()
        updateUserChip()
      } catch (err: any) {
        if (isAuthError(err)) {
          await doLogout()
        } else {
          console.warn('getMe failed (transient), keeping session', err)
        }
      }
    })()
  }
}

// ── Wiring + startup ─────────────────────────────────────────────────────
wireUi()
wireMembers()
wireSettings()
wireMcp()

void init()
