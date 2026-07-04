// executor — port of device/shared/src/executor/index.ts. The Electron version
// read the local enable/disable map from electron-store; here the host (main.ts)
// injects a provider backed by the Tauri settings file.

import './catalog' // side-effect: register built-in tools
import { getTool, listToolIds, listToolDefs, type ToolDef } from './registry'
import { native } from '../native'

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

// toolEnabled / local checkboxes removed — all server-issued MCPs are available.
// Execution gating for per-task allowedTools (from server) is still supported below.

function enabledToolIds(): string[] {
  return listToolIds()
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
  if (!def || (allowed && !allowed.has(tool))) {
    return {
      success: false,
      tool,
      result: null,
      summary: !def
        ? `Unknown tool: ${tool}. Use one of: ${getAvailableTools().join(', ')}`
        : `Tool not allowed for this task: ${tool}.`,
    }
  }

  // Runtime tools (powershell/shell) spawn with workspaceRoot as their
  // cwd. When the default workspace (~\HeySureWorkspace) was never created via
  // the settings UI, the spawn fails on Windows with "目录名称无效。(os error
  // 267)". Create it lazily before any tool runs so cwd is always valid.
  try {
    if (workspaceRoot && workspaceRoot.trim()) await native.ensureDir(workspaceRoot)
  } catch { /* best effort — a runner that doesn't need cwd still works */ }

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
  return listToolDefs()
}

export function getAllToolDefs(): ToolDef[] {
  return listToolDefs()
}
