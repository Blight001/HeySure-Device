// popup/ui.ts — shared presentation layer: theme, the 3-state connection
// indicator, settings/login/members modals, tool-call stats and the auth chip.

import { DeviceStatus } from '../lib/types'
import { state } from './state'
import { sendToBackground } from './transport'
import * as dom from './dom'
import { currentAvatarHtml } from './helpers'
import { renderMembers } from './members'

// ── Status indicator (green / yellow / red) ─────────────────────────────────
// green:  connected AND an AI is assigned (boundAiConfigId set)
// yellow: connected but no AI assigned yet
// red:    not connected to the server
export function renderStatus() {
  const connected = state.currentStatus === 'registered' || state.currentStatus === 'connected'
  let color: 'green' | 'yellow' | 'red'
  let label: string
  if (state.offlineMode) {
    // Offline mode never talks to the server; treat as not-connected (red).
    color = 'red'; label = '离线模式'
  } else if (!connected) {
    color = 'red'; label = '未连接'
  } else if (state.boundAiConfigId == null) {
    color = 'yellow'; label = '未分配'
  } else {
    color = 'green'; label = '已连接'
  }
  dom.statusDot.className = `status-dot ${color}`
  dom.statusLabel.textContent = label
}

export function setStatus(status: DeviceStatus) {
  state.currentStatus = status
  // Losing the connection clears any prior AI binding so we don't show green
  // while offline; it is re-applied on the next device:registered.
  if (status !== 'registered' && status !== 'connected') state.boundAiConfigId = null
  renderStatus()
  renderMembers()
}

export function setBoundAi(aiConfigId: number | null) {
  state.boundAiConfigId = aiConfigId
  renderStatus()
  renderMembers()
}

// ── Theme ──────────────────────────────────────────────────────────────────
export function applyTheme(theme: 'dark' | 'light', persist = true) {
  state.currentTheme = theme
  document.body.className = theme
  dom.themeToggle.textContent = theme === 'dark' ? '☀️' : '🌙'
  if (persist) sendToBackground({ type: 'settings:save', payload: { theme } })
}

// ── Tool-call stats ──────────────────────────────────────────────────────
export function renderStats() {
  dom.statTotal.textContent   = String(state.stats.total)
  dom.statRunning.textContent = String(state.stats.running)
  dom.statSuccess.textContent = String(state.stats.success)
  dom.statFailed.textContent  = String(state.stats.failed)
}

// ── Modals ───────────────────────────────────────────────────────────────
export function openSettingsModal()  { dom.settingsModal.classList.remove('hidden') }
export function closeSettingsModal() { dom.settingsModal.classList.add('hidden') }
export function openLoginModal() {
  dom.loginModal.classList.remove('hidden')
  updateUserChip()
  dom.loginAccount.value = state.auth.account || ''
  dom.loginPassword.value = state.auth.password || ''
  dom.loginRemember.checked = !!state.auth.rememberLogin
  setTimeout(() => { if (!state.auth.token) dom.loginAccount.focus() }, 0)
}
export function closeLoginModal()  { dom.loginModal.classList.add('hidden') }
export function openMembersModal() {
  dom.membersModal.classList.remove('hidden')
  renderMembers()
}
export function closeMembersModal() { dom.membersModal.classList.add('hidden') }

// ── Auth chip ──────────────────────────────────────────────────────────────
export function updateUserChip() {
  const auth = state.auth
  if (auth.token) {
    dom.userChip.classList.remove('guest')
    dom.userAva.innerHTML = currentAvatarHtml((auth.userName || auth.account || '?').slice(0, 1).toUpperCase())
    dom.userName.textContent = auth.userName || auth.account || '已登录'
  } else {
    dom.userChip.classList.add('guest')
    dom.userAva.textContent = '·'
    dom.userName.textContent = '未登录'
  }
  dom.accountCard.style.display = auth.token ? 'block' : 'none'
  dom.loginGate.classList.toggle('hidden', !!auth.token)
  dom.accountStatusV.textContent = auth.token ? `已登录：${auth.userName || auth.account}` : '未登录'
}

// ── Offline UI ───────────────────────────────────────────────────────────────
export function updateOfflineUi() {
  dom.offlineModelConfig.classList.toggle('hidden', !state.offlineMode)
  renderStatus()
  renderMembers()
}

// ── Wiring ───────────────────────────────────────────────────────────────
export function wireUi() {
  dom.themeToggle.addEventListener('click', () => applyTheme(state.currentTheme === 'dark' ? 'light' : 'dark'))
  dom.settingsBtn.addEventListener('click', () => openSettingsModal())
  dom.offlineChatBtn.addEventListener('click', () => {
    chrome.windows.create({
      url: chrome.runtime.getURL('offline-chat.html'),
      type: 'popup',
      width: 920,
      height: 720,
    })
  })
  dom.settingsClose.addEventListener('click', () => closeSettingsModal())
  dom.settingsModal.addEventListener('click', (e) => { if (e.target === dom.settingsModal) closeSettingsModal() })
  // The status indicator opens the connection / AI assignment modal.
  dom.statusPill.addEventListener('click', () => openMembersModal())
}
