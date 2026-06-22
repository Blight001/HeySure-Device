// tools/overrides.ts — build the MCP catalog the extension reports to the server.
//
// Schema source of truth matches the Windows desktop model:
//   1. Server-pushed tools (device:tool-config, memory-only) win on name conflicts.
//   2. Locally-authored dynamic tools (chrome.storage) are merged next.
//   3. Hardcoded BROWSER_TOOLS schemas are a connect-time fallback only, until the
//      server seeds/pushes workspace files under device_tools/browser/.
//
// Execution still uses the packaged browser.ts handlers; server program wrappers
// forward to builtin:*. Tool enable/disable stays in chrome.storage (desktop
// keeps an equivalent in Electron store). Description overrides are NOT applied
// to server-managed tools — edit those on the server / web console instead.

import { BROWSER_TOOLS, isToolEnabledByDefault } from './definitions'
import { AIToolDef } from '../types'
import { getToolDescOverrides, getToolEnabledMap } from '../storage'
import { dynamicMcpToolDefs, isServerManagedToolDef } from './dynamic'

const BUILTIN_IMPL = {
  kind: 'builtin' as const,
  source_files: ['src/lib/tools/definitions.ts', 'src/lib/tools/browser.ts', 'src/lib/tools/router.ts', 'dist/background.js'],
  editable_via: 'browser_mcp.manage_dynamic_tool',
}

export async function allToolDefs(): Promise<AIToolDef[]> {
  const merged = new Map<string, AIToolDef>()
  for (const tool of await dynamicMcpToolDefs()) merged.set(tool.name, tool)
  for (const tool of BROWSER_TOOLS) {
    if (merged.has(tool.name)) continue
    merged.set(tool.name, { ...tool, implementation: BUILTIN_IMPL })
  }
  return Array.from(merged.values())
}

/** Resolve every browser tool's effective on/off state (explicit choice ?? default). */
export async function resolveToolEnabledMap(): Promise<Record<string, boolean>> {
  const explicit = await getToolEnabledMap()
  const out: Record<string, boolean> = {}
  for (const tool of await allToolDefs()) {
    out[tool.name] = tool.name in explicit ? !!explicit[tool.name] : isToolEnabledByDefault(tool.name)
  }
  return out
}

/** Names of the currently enabled tools. */
export async function enabledToolNames(): Promise<string[]> {
  const enabled = await resolveToolEnabledMap()
  return (await allToolDefs()).filter(t => enabled[t.name]).map(t => t.name)
}

export async function effectiveToolDefs(): Promise<AIToolDef[]> {
  const overrides = await getToolDescOverrides()
  const enabled = await resolveToolEnabledMap()
  return (await allToolDefs()).filter(tool => enabled[tool.name]).map(tool => {
    if (isServerManagedToolDef(tool)) return tool
    const o = overrides[tool.name]
    if (!o) return tool
    const desc = (o.description || '').trim()
    const props = tool.input_schema?.properties || {}
    let nextProps = props
    if (o.parameters && Object.keys(o.parameters).length) {
      nextProps = {}
      for (const [k, v] of Object.entries(props)) {
        const pd = (o.parameters[k] || '').trim()
        nextProps[k] = pd ? { ...(v as any), description: pd } : v
      }
    }
    return {
      ...tool,
      description: desc || tool.description,
      input_schema: { ...tool.input_schema, properties: nextProps },
    }
  })
}