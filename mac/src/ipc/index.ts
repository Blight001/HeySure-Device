// IPC registration entry point. Each module registers its own ipcMain
// handlers, keeping wire-protocol concerns close to the business logic.

import { registerSettingsIpc } from './settings'
import { registerDeviceIpc } from './device'
import { registerAuthIpc } from './auth'
import { registerAiConfigIpc } from './ai-config'
import { registerMcpIpc } from './mcp'
import { registerOfflineChatIpc } from './offline-chat'

export function registerAllIpc(): void {
  registerSettingsIpc()
  registerDeviceIpc()
  registerAuthIpc()
  registerAiConfigIpc()
  registerMcpIpc()
  registerOfflineChatIpc()
}
