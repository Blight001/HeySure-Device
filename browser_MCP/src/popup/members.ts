// popup/members.ts — software-end account: login / logout and the connection /
// AI assignment status modal. The device no longer picks its own AI; an
// operator assigns one from the web "作坊" (Workshop) panel.

import { state } from './state'
import { sendToBackground } from './transport'
import * as dom from './dom'
import { refreshAvatarCache } from './helpers'
import { login as apiLogin } from '../lib/client'
import { saveAuth, clearAuth, getAuth, saveSettings, clearAvatarCache } from '../lib/storage'
import {
  updateUserChip, renderStatus, openLoginModal,
  closeLoginModal, openMembersModal, closeMembersModal,
} from './ui'

function renderConnectionInfo() {
  const connected = state.currentStatus === 'registered' || state.currentStatus === 'connected'
  dom.connectionStatusV.textContent = connected ? '已连接到服务器' : '未连接到服务器'
  dom.aiStatusV.textContent = state.boundAiConfigId == null ? '未分配' : '已分配 AI'
  dom.serverStatusV.textContent = state.serverUrl || '-'
  renderStatus()
}

export async function doLogin() {
  const configuredServerUrl = dom.cfgServer.value.trim()
  if (configuredServerUrl && configuredServerUrl !== state.serverUrl) {
    state.serverUrl = configuredServerUrl
    await saveSettings({ serverUrl: state.serverUrl })
    sendToBackground({ type: 'settings:save', payload: { serverUrl: state.serverUrl } })
  }
  const account = dom.loginAccount.value.trim()
  const password = dom.loginPassword.value
  if (!account || !password) { dom.loginFeedback.textContent = '请输入账号和密码'; dom.loginFeedback.style.color = 'var(--error)'; return }
  if (!state.serverUrl) { dom.loginFeedback.textContent = '请先在设置中配置服务器 URL'; dom.loginFeedback.style.color = 'var(--error)'; return }
  dom.loginBtn.disabled = true
  dom.loginFeedback.textContent = '登录中…'
  dom.loginFeedback.style.color = 'var(--muted)'
  try {
    const { token, user, agentSocketUrl } = await apiLogin(state.serverUrl, account, password)
    const rememberLogin = dom.loginRemember.checked
    state.auth = {
      token,
      account: rememberLogin ? account : '',
      password: rememberLogin ? password : '',
      rememberLogin,
      userId: user?.id ?? null,
      userName: user?.name || account,
      avatar: user?.avatar || '',
    }
    await saveSettings({ agentSocketUrl })
    await saveAuth(state.auth)
    if (!rememberLogin) {
      dom.loginAccount.value = ''
      dom.loginPassword.value = ''
    }
    dom.loginFeedback.textContent = '登录成功 ✓'
    dom.loginFeedback.style.color = 'var(--success)'
    updateUserChip()
    await refreshAvatarCache()
    updateUserChip()
    // Logged in → link to the server. The device then shows up in the web
    // Workshop panel where an operator assigns it an AI.
    sendToBackground({ type: 'device:connect' })
    closeLoginModal()
    openMembersModal()
  } catch (err: any) {
    dom.loginFeedback.textContent = `登录失败：${err?.message || err}`
    dom.loginFeedback.style.color = 'var(--error)'
    sendToBackground({ type: 'device:connect' })
  } finally {
    dom.loginBtn.disabled = false
  }
}

export async function doLogout() {
  await clearAuth()
  sendToBackground({ type: 'auth:logout' })
  state.auth = await getAuth()
  dom.loginAccount.value = state.auth.account || ''
  dom.loginPassword.value = state.auth.password || ''
  dom.loginRemember.checked = !!state.auth.rememberLogin
  state.avatarDataUrl = ''
  await clearAvatarCache()
  closeMembersModal()
  updateUserChip()
  renderConnectionInfo()
}

export function renderMembers() {
  renderConnectionInfo()
}

export function wireMembers() {
  dom.loginBtn.addEventListener('click', () => void doLogin())
  dom.loginPassword.addEventListener('keydown', e => { if ((e as KeyboardEvent).key === 'Enter') void doLogin() })
  dom.userChip.addEventListener('click', () => openLoginModal())
  dom.userChip.addEventListener('keydown', (e) => {
    const key = (e as KeyboardEvent).key
    if (key === 'Enter' || key === ' ') { e.preventDefault(); openLoginModal() }
  })
  dom.loginModal.addEventListener('click', (e) => { if (e.target === dom.loginModal) closeLoginModal() })
  dom.loginModalClose.addEventListener('click', () => closeLoginModal())
  dom.membersModal.addEventListener('click', (e) => { if (e.target === dom.membersModal) closeMembersModal() })
  dom.membersModalClose.addEventListener('click', () => closeMembersModal())
  dom.logoutBtn.addEventListener('click', () => void doLogout())
  dom.connectBtn.addEventListener('click', () => sendToBackground({ type: 'device:connect' }))
  dom.disconnectBtn.addEventListener('click', () => sendToBackground({ type: 'device:disconnect' }))
}
