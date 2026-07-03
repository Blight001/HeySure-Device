// executor — port of device/shared/src/executor/index.ts. The Electron version
// read the local enable/disable map from electron-store; here the host (main.ts)
// injects a provider backed by the Tauri settings file.

import './catalog' // side-effect: register built-in tools
import { getTool, listToolIds, listToolDefs, type ToolDef } from './registry'

export interface DispatchedTask {
  taskId: string
  userId?: string | number
  aiConfigId?: string | number
  sessionId?: string
  instruction?: string
  tool?: string
  args?: Record<string, any>
  allowedTools?: string[]
}

export interface TaskResult {
  success: boolean
  tool: string
  result: any
  summary: string
}

let toolEnabledProvider: () => Record<string, boolean> = () => ({})

export function setToolEnabledProvider(provider: () => Record<string, boolean>): void {
  toolEnabledProvider = provider
}

export function isToolEnabled(tool: string): boolean {
  return toolEnabledProvider()[tool] !== false
}

function enabledToolIds(): string[] {
  return listToolIds().filter(isToolEnabled)
}

// A dispatch without an explicit tool falls back to running the raw
// instruction through shell.run (a server-pushed runtime tool).
function inferTool(_instruction: string): string {
  return 'shell.run'
}

export async function executeTask(workspaceRoot: string, task: DispatchedTask): Promise<TaskResult> {
  const tool = task.tool || inferTool(task.instruction || '')
  const args = { ...(task.args || {}) }

  if (!task.tool && task.instruction) {
    args.instruction = task.instruction
    if (!args.command && tool === 'shell.run') args.command = task.instruction
  }

  const allowed = Array.isArray(task.allowedTools)
    ? new Set(task.allowedTools.map(t => String(t || '').trim()).filter(Boolean))
    : null
  const def = getTool(tool)
  if (!def || !isToolEnabled(tool) || (allowed && !allowed.has(tool))) {
    return {
      success: false,
      tool,
      result: null,
      summary: !def
        ? `Unknown tool: ${tool}. Use one of: ${getAvailableTools().join(', ')}`
        : !isToolEnabled(tool)
          ? `Tool disabled locally: ${tool}. Enable it in the desktop MCP tools page first.`
          : `Tool not allowed for this task: ${tool}.`,
    }
  }

  try {
    const result = await def.handler({ workspaceRoot, args })
    return { success: true, tool, result, summary: `${tool} completed successfully` }
  } catch (err: any) {
    return { success: false, tool, result: null, summary: err?.message || String(err) }
  }
}

export function getAvailableTools(): string[] {
  return enabledToolIds()
}

export function getToolDefs(): ToolDef[] {
  return listToolDefs().filter(def => isToolEnabled(def.name))
}

export function getAllToolDefs(): ToolDef[] {
  return listToolDefs()
}
