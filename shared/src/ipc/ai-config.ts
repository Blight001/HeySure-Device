import { ipcMain } from 'electron'
import { store } from '../store'
import {
  requireAuth, serverFetch,
} from '../services/server-client'
import {
  rebuildAgent, clearSelectedAiConfig, getAgent,
} from '../services/device-runtime'
import { platformProfile } from '../platform'

export function registerAiConfigIpc(): void {
  ipcMain.handle('ai-config:list', async () => {
    const { base, token } = requireAuth(store.store)
    return serverFetch(base, '/api/ai/configs', { token, failureMessage: '获取 AI 列表失败' })
  })

  ipcMain.handle('ai-config:runtime-status', async () => {
    const s = store.store
    if (!s.serverUrl || !s.authToken) return []
    try {
      const { base, token } = requireAuth(s)
      return await serverFetch(base, '/api/ai/runtime-status', { token, failureMessage: '运行状态查询失败' })
    } catch { return [] }
  })

  ipcMain.handle('ai-config:select', async (_event, cfg: any) => {
    if (!store.get('authToken')) {
      clearSelectedAiConfig()
      getAgent()?.updateSettings(store.store)
      throw new Error('请先登录后再选择 AI 成员')
    }
    if (!cfg?.id) throw new Error('AI 成员无效')

    store.set('selectedAiConfigId', cfg.id)
    store.set('selectedAiConfigName', cfg.name)
    store.set('selectedAiConfigRole', cfg.digital_member_role || 'member')
    store.set('selectedAiConfigLifecycle', cfg.lifecycle_status || 'working')
    store.set('selectedAiConfigProject', cfg.project_name || '')
    store.set('agentToken', store.get('authToken'))
    store.set('deviceId', `${platformProfile.deviceIdPrefix}${cfg.id}`)
    store.set('agentName', platformProfile.agentName)
    store.set('agentGroup', cfg.project_name || '')

    const agent = rebuildAgent(store.store)
    agent.connect()
    return { success: true }
  })

  ipcMain.handle('ai-config:clone', async (_event, configId: number) => {
    const { base, token } = requireAuth(store.store)
    return serverFetch(base, `/api/ai/configs/${configId}/clone`, {
      method: 'POST', token, failureMessage: '克隆失败',
    })
  })
}
