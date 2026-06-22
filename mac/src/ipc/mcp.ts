// ipc/mcp.ts — the desktop MCP tool page: list this device's tools (with local
// description edits merged), save a description edit locally, and run one tool
// locally for the tester. Edits are reported to the server via toolDefs on the
// next register, so the server needs no per-tool storage.

import { ipcMain } from 'electron'
import { store } from '../store'
import { getAgent } from '../services/device-runtime'
import { getAllToolDefs, getToolDefs, isToolEnabled } from '../executor'
import { sendActivityLog } from '../services/activity-log'

type DescOverride = { description?: string; parameters?: Record<string, string> }

function overrides(): Record<string, DescOverride> {
  return (store.get('toolDescOverrides') as any) || {}
}

function enabledMap(): Record<string, boolean> {
  return (store.get('toolEnabled') as any) || {}
}

function setEnabled(name: string, enabled: boolean) {
  const all = enabledMap()
  if (enabled) delete all[name]
  else all[name] = false
  store.set('toolEnabled', all)
}

// Tool defs with the saved local description edits applied.
function effectiveDefs(includeDisabled = false) {
  const ov = overrides()
  const defs = includeDisabled ? getAllToolDefs() : getToolDefs()
  return defs.map(def => {
    const o = ov[def.name]
    if (!o) return def
    const desc = String(o.description || '').trim()
    const props = (def.input_schema && def.input_schema.properties) || {}
    let nextProps: Record<string, any> = props
    if (o.parameters && Object.keys(o.parameters).length) {
      nextProps = {}
      for (const [k, v] of Object.entries(props)) {
        const pd = String(o.parameters[k] || '').trim()
        nextProps[k] = pd ? { ...(v as any), description: pd } : v
      }
    }
    return { ...def, description: desc || def.description, input_schema: { ...def.input_schema, properties: nextProps } }
  })
}

export function registerMcpIpc(): void {
  // List effective tool defs + which tools have local edits.
  ipcMain.handle('mcp:list', () => ({
    tools: effectiveDefs(true),
    overrides: overrides(),
    enabled: enabledMap(),
  }))

  ipcMain.handle('mcp:set-enabled', (_e, payload: { tool: string; enabled: boolean }) => {
    const name = String(payload?.tool || '').trim()
    if (!name) return false
    const known = getAllToolDefs().some(def => def.name === name)
    if (!known) return false
    setEnabled(name, payload?.enabled !== false)
    getAgent()?.refreshRegistration()
    return true
  })

  // Save (or clear) a tool's local description / parameter edits.
  ipcMain.handle('mcp:save-desc', (_e, payload: { tool: string; description?: string; parameters?: Record<string, string> }) => {
    const name = String(payload?.tool || '').trim()
    if (!name) return false
    const all = overrides()
    const desc = String(payload.description || '').trim()
    const params: Record<string, string> = {}
    for (const [k, v] of Object.entries(payload.parameters || {})) {
      const pn = String(k || '').trim(); const pv = String(v || '').trim()
      if (pn && pv) params[pn] = pv
    }
    if (!desc && Object.keys(params).length === 0) delete all[name]
    else all[name] = { description: desc, parameters: params }
    store.set('toolDescOverrides', all)
    // Re-report toolDefs so the server picks up the edit (no reconnect needed).
    getAgent()?.refreshRegistration()
    return true
  })

  // Run one tool locally for the tester.
  ipcMain.handle('mcp:test', async (_e, payload: { tool: string; args: Record<string, any> }) => {
    const tool = String(payload?.tool || '').trim()
    if (!tool) return { success: false, error: '工具名为空' }
    if (!isToolEnabled(tool)) return { success: false, error: '该工具已在本机 MCP 栏目中关闭' }
    const agent = getAgent()
    if (!agent) return { success: false, error: 'agent 未初始化' }
    sendActivityLog('task', 'running', `测试: ${tool}`, payload.args)
    try {
      const r = await agent.runToolLocally(tool, payload.args || {})
      sendActivityLog('task', r.success ? 'success' : 'error', `测试${r.success ? '完成' : '失败'}: ${tool}`)
      return { success: r.success, result: r.result, summary: r.summary }
    } catch (err: any) {
      sendActivityLog('task', 'error', `测试失败: ${tool} — ${err?.message || err}`)
      return { success: false, error: err?.message || String(err) }
    }
  })
}
