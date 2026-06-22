import { ipcMain } from 'electron'
import { store } from '../store'
import { showOfflineChatWindow } from '../windows/offline-chat-window'
import { isOfflineChatAbortError, runOfflineChat, OfflineChatMessage } from '../services/offline-ai'

const offlineChatControllers = new Map<string, AbortController>()

export function registerOfflineChatIpc(): void {
  ipcMain.handle('offline-chat:open', () => {
    showOfflineChatWindow()
    return true
  })

  ipcMain.handle('offline-chat:get-config', () => ({
    localMode: true,
    prompt: store.get('offlinePrompt') || '',
    aiBaseUrl: store.get('aiBaseUrl') || '',
    aiModel: store.get('aiModel') || '',
    hasAiKey: !!store.get('aiKey'),
  }))

  ipcMain.handle('offline-chat:save-prompt', (_e, prompt: string) => {
    store.set('offlinePrompt', String(prompt || '').trim())
    return true
  })

  ipcMain.handle('offline-chat:send', async (event, payload: { requestId?: string; messages: OfflineChatMessage[]; prompt?: string; allowedTools?: string[] }) => {
    const messages = Array.isArray(payload?.messages) ? payload.messages : []
    const allowedTools = Array.isArray(payload?.allowedTools) ? payload.allowedTools : undefined
    const requestId = String(payload?.requestId || '')
    const controller = new AbortController()
    if (requestId) offlineChatControllers.set(requestId, controller)
    try {
      return await runOfflineChat(messages, payload?.prompt, allowedTools, progress => {
        event.sender.send('offline-chat:progress', { requestId, ...progress })
      }, controller.signal)
    } catch (err: any) {
      if (isOfflineChatAbortError(err, controller.signal)) {
        return {
          text: '已停止',
          toolsUsed: [],
          toolEvents: [],
          cancelled: true,
        }
      }
      throw err
    } finally {
      if (requestId) offlineChatControllers.delete(requestId)
    }
  })

  ipcMain.handle('offline-chat:cancel', (_event, payload: { requestId?: string }) => {
    const requestId = String(payload?.requestId || '')
    if (!requestId) return false
    const controller = offlineChatControllers.get(requestId)
    if (!controller) return false
    controller.abort()
    return true
  })
}
