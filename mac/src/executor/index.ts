import './catalog' // side-effect: register built-in tools
import { getTool, listToolIds, listToolDefs, ToolDef } from './registry'
import { inferTool } from './infer'
import { store } from '../store'

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

function toolEnabledMap(): Record<string, boolean> {
  return (store.get('toolEnabled') as any) || {}
}

export function isToolEnabled(tool: string): boolean {
  const value = toolEnabledMap()[tool]
  return value !== false
}

function enabledToolIds(): string[] {
  return listToolIds().filter(isToolEnabled)
}

export async function executeTask(workspaceRoot: string, task: DispatchedTask): Promise<TaskResult> {
  const tool = task.tool || inferTool(task.instruction || '')
  const args = { ...(task.args || {}) }

  // For inferred shell.run, fall back to the raw instruction as the command
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
