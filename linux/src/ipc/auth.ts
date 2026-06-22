import { ipcMain } from 'electron'
import { store } from '../store'
import { resolveAgentSocketUrl, resolveBaseUrl, serverFetch } from '../services/server-client'
import { cacheUserAvatar } from '../services/avatar-cache'
import {
  getAgent, rebuildAgent, clearSelectedAiConfig,
} from '../services/device-runtime'

export function registerAuthIpc(): void {
  ipcMain.handle('auth:login', async (_event, params: { serverUrl: string; account: string; password: string; remember?: boolean }) => {
    const { serverUrl, account, password, remember } = params
    if (!serverUrl) throw new Error('服务器 URL 不能为空')

    let base: string
    try { base = resolveBaseUrl(serverUrl) } catch { throw new Error('服务器 URL 格式无效') }

    const data = await serverFetch<any>(base, '/api/auth/login', {
      method: 'POST',
      body: { account, password },
      failureMessage: '登录失败',
    })

    const agentSocketUrl = resolveAgentSocketUrl(String(data.agent_socket_url || ''))
    if (!agentSocketUrl) throw new Error('登录响应缺少 Agent 连接地址')
    store.set('serverUrl', base)
    store.set('agentSocketUrl', agentSocketUrl)
    store.set('authToken', data.access_token)
    store.set('userAccount', remember ? account : '')
    store.set('userPassword', remember ? password : '')
    store.set('rememberLogin', !!remember)
    store.set('userName', String(data.user?.name || data.user?.nickname || account))
    store.set('userAvatar', String(data.user?.avatar || ''))
    store.set('userId', data.user?.id ?? null)
    await cacheUserAvatar(base, String(data.user?.avatar || ''))
    clearSelectedAiConfig()
    getAgent()?.updateSettings(store.store)
    return { success: true, user: data.user }
  })

  ipcMain.handle('auth:logout', () => {
    // Disconnect any live socket first so the server sees us leaving.
    getAgent()?.disconnect()
    store.set('authToken', '')
    store.set('agentSocketUrl', '')
    if (store.get('rememberLogin')) {
      store.set('userAccount', store.get('userAccount') || '')
      store.set('userPassword', store.get('userPassword') || '')
    } else {
      store.set('userAccount', '')
      store.set('userPassword', '')
    }
    store.set('rememberLogin', !!store.get('rememberLogin'))
    store.set('userName', '')
    store.set('userAvatar', '')
    store.set('userAvatarDataUrl', '')
    store.set('userId', null)
    clearSelectedAiConfig()
    // Rebuild the agent so its in-memory `settings` snapshot (which still
    // holds the old authToken) is replaced with the cleared store. Without
    // this, a subsequent connect() would reuse the stale token.
    rebuildAgent(store.store)
    return { success: true }
  })
}
