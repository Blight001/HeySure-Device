// dynamic — applies MCP tools the server pushes down (device:tool-config).
//
// The device authors nothing here: every tool beyond the transport protocol
// itself is defined server-side (by an AI via the library-bound
// device_mcp.manage tool, or by a human in the web console) and pushed to
// this device at runtime. There is no local/device-authored tool store and
// no device-side "manage" MCP tool — see device/read.md for the full
// static toolDefs (device-owned) vs. dynamic MCP (server-owned) boundary.

import { sha256Hex } from '../sha256'
import { getBuiltinTool, getTool, listBuiltinToolIds, replaceDynamicTools, type ToolDefinition } from './registry'
import { runRuntimeTool, isToolRuntime, type ToolRuntime } from '../runtime/runtime-tool'

export interface DynamicMcpDefinition {
  name: string
  description: string
  input_schema: Record<string, any>
  // 'program' → run the call/set/return DSL in ``code``.
  // 'js'      → run ``js`` (a function body) with (args, cap, ctx) in scope.
  // 'runtime' → run ``source`` via a device runtime (powershell/shell).
  code_kind?: 'program' | 'js' | 'runtime'
  code: DynamicInstruction[]
  js?: string
  runtime?: ToolRuntime
  source?: string
  permissions?: string[]
}

type DynamicInstruction = {
  op: 'call' | 'set' | 'return'
  tool?: string
  args?: any
  name?: string
  value?: any
  save_as?: string
}

const NAME_RE = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/

// The current server-pushed set, applied to the registry.
let definitions: DynamicMcpDefinition[] = []
let appliedServerRevision = ''
let changeListener: (() => void) | null = null

function revision(value: any): string {
  return sha256Hex(JSON.stringify(value))
}

function validate(raw: any): DynamicMcpDefinition {
  const name = String(raw?.name || '').trim()
  if (!NAME_RE.test(name)) throw new Error(`Invalid dynamic MCP name: ${name || '(empty)'}`)
  const description = String(raw?.description || '').trim()
  if (!description) throw new Error(`Dynamic MCP ${name} requires description`)
  const inputSchema = raw?.input_schema ?? raw?.inputSchema
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    throw new Error(`Dynamic MCP ${name} requires input_schema`)
  }
  const runtime = String(raw?.runtime || '').trim().toLowerCase()
  const kind = String(raw?.code_kind || raw?.codeKind
    || (runtime ? 'runtime' : (String(raw?.js || '').trim() ? 'js' : 'program')))
  if (kind === 'runtime') {
    if (!isToolRuntime(runtime)) throw new Error(`Dynamic MCP ${name} has invalid runtime: ${runtime || '(empty)'}`)
    const source = String(raw?.source ?? raw?.code ?? '')
    if (!source.trim()) throw new Error(`Dynamic MCP ${name} requires non-empty source`)
    const permissions = Array.isArray(raw?.permissions) ? raw.permissions.map((p: any) => String(p)) : []
    return { name, description, input_schema: inputSchema, code_kind: 'runtime', code: [], runtime: runtime as ToolRuntime, source, permissions }
  }
  if (kind === 'js') {
    const js = String(raw?.js || '')
    if (!js.trim()) throw new Error(`Dynamic MCP ${name} requires non-empty js`)
    return { name, description, input_schema: inputSchema, code_kind: 'js', code: [], js }
  }
  const code = typeof raw?.code === 'string' ? JSON.parse(raw.code) : raw?.code
  if (!Array.isArray(code) || !code.length || code.length > 32) {
    throw new Error(`Dynamic MCP ${name} code must contain 1-32 instructions`)
  }
  for (const step of code) {
    if (!step || !['call', 'set', 'return'].includes(step.op)) throw new Error(`Invalid instruction in ${name}`)
    if (step.op === 'call' && !String(step.tool || '').trim()) throw new Error(`call instruction in ${name} requires tool`)
    if (step.op === 'set' && !String(step.name || '').trim()) throw new Error(`set instruction in ${name} requires name`)
  }
  return { name, description, input_schema: inputSchema, code_kind: 'program', code }
}

// The native capability library injected into server-authored JS tools.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
  new (...args: string[]) => (...a: any[]) => Promise<any>

function buildCap(workspaceRoot: string): Record<string, any> {
  const call = (id: string, args?: any) => {
    const builtin = getBuiltinTool(String(id || '').trim())
    if (!builtin) throw new Error(`Capability not found: ${id}`)
    return builtin.handler({ workspaceRoot, args: args || {} })
  }
  const cap: Record<string, any> = { call }
  for (const id of listBuiltinToolIds()) {
    const dot = id.indexOf('.')
    if (dot > 0) {
      const ns = id.slice(0, dot)
      const fn = id.slice(dot + 1)
      cap[ns] = cap[ns] || {}
      if (typeof cap[ns] === 'object') cap[ns][fn] = (args?: any) => call(id, args)
    } else {
      cap[id] = (args?: any) => call(id, args)
    }
  }
  return cap
}

async function runJs(def: DynamicMcpDefinition, workspaceRoot: string, args: Record<string, any>): Promise<any> {
  const cap = buildCap(workspaceRoot)
  const ctx = { workspaceRoot }
  const fn = new AsyncFunction('args', 'cap', 'ctx', String(def.js || ''))
  return fn(args || {}, cap, ctx)
}

function lookup(root: any, dotted: string): any {
  return dotted.split('.').filter(Boolean).reduce((value, key) => value == null ? undefined : value[key], root)
}

function render(value: any, context: Record<string, any>): any {
  if (Array.isArray(value)) return value.map(item => render(item, context))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, render(item, context)]))
  }
  if (typeof value !== 'string') return value
  const exact = value.match(/^\$\{([^}]+)\}$/)
  if (exact) return lookup(context, exact[1])
  return value.replace(/\$\{([^}]+)\}/g, (_all, expr) => {
    const found = lookup(context, expr)
    return found == null ? '' : typeof found === 'string' ? found : JSON.stringify(found)
  })
}

async function runProgram(def: DynamicMcpDefinition, workspaceRoot: string, args: Record<string, any>, depth = 0): Promise<any> {
  if (depth > 8) throw new Error('Dynamic MCP call depth exceeded')
  const context: Record<string, any> = { args, vars: {}, last: null, workspaceRoot }
  for (const step of def.code) {
    if (step.op === 'set') {
      context.vars[String(step.name)] = render(step.value, context)
      continue
    }
    if (step.op === 'return') return render(step.value, context)
    const target = String(render(step.tool || '', context) || '').trim()
    const builtinTarget = target.startsWith('builtin:') ? target.slice('builtin:'.length) : ''
    const child = definitions.find(item => item.name === target)
    const childArgs = render(step.args || {}, context)
    let result: any
    if (builtinTarget) {
      const builtin = getBuiltinTool(builtinTarget)
      if (!builtin) throw new Error(`Built-in MCP not found: ${builtinTarget}`)
      result = await builtin.handler({ workspaceRoot, args: childArgs })
    } else if (child) result = await runProgram(child, workspaceRoot, childArgs, depth + 1)
    else {
      const tool = getTool(target)
      if (!tool) throw new Error(`Dynamic MCP dependency not found: ${target}`)
      result = await tool.handler({ workspaceRoot, args: childArgs })
    }
    context.last = result
    if (step.save_as) context.vars[String(step.save_as)] = result
  }
  return context.last
}

function asTool(def: DynamicMcpDefinition): ToolDefinition {
  return {
    id: def.name,
    platform: 'all',
    description: def.description,
    inputSchema: def.input_schema,
    implementation: {
      kind: 'dynamic',
      definition: def,
      code_kind: def.code_kind || 'program',
      code: def.code,
      source: 'server',
    },
    handler: ({ workspaceRoot, args }) =>
      def.code_kind === 'runtime'
        ? runRuntimeTool(
            { name: def.name, runtime: def.runtime as ToolRuntime, source: def.source || '', permissions: def.permissions, description: def.description },
            workspaceRoot, args || {})
        : def.code_kind === 'js' ? runJs(def, workspaceRoot, args || {}) : runProgram(def, workspaceRoot, args || {}),
  }
}

// Drop server-pushed tools from memory (e.g. on disconnect).
export function clearServerDynamicMcp(): { cleared: boolean; tools: number; server: number } {
  const hadServer = definitions.length > 0 || !!appliedServerRevision
  definitions = []
  appliedServerRevision = ''
  replaceDynamicTools([])
  if (hadServer) changeListener?.()
  return { cleared: hadServer, tools: 0, server: 0 }
}

// Apply a server-pushed dynamic MCP set (device:tool-config). Returns
// applied:false when the set is unchanged — this guard stops the
// register→push→apply loop, since applying re-registers and the server
// re-pushes the same set.
export function applyServerDynamicMcp(payload: any): {
  applied: boolean
  revision: string
  tools: number
  rejected: Array<{ name: string; error: string }>
} {
  const list = Array.isArray(payload) ? payload : payload?.tools
  const tools: DynamicMcpDefinition[] = []
  const rejected: Array<{ name: string; error: string }> = []
  const names = new Set<string>()
  for (const raw of Array.isArray(list) ? list : []) {
    const rawName = String(raw?.name || '').trim() || '(unnamed)'
    try {
      const item = validate(raw)
      if (names.has(item.name)) throw new Error(`Duplicate dynamic MCP: ${item.name}`)
      names.add(item.name)
      tools.push(item)
    } catch (err: any) {
      rejected.push({ name: rawName, error: err?.message || String(err) })
    }
  }
  const rev = revision(tools)
  if (rev === appliedServerRevision) return { applied: false, revision: rev, tools: tools.length, rejected }
  definitions = tools
  appliedServerRevision = rev
  replaceDynamicTools(tools.map(asTool))
  changeListener?.()
  return { applied: true, revision: rev, tools: tools.length, rejected }
}

export function initializeDynamicMcp(listener?: () => void): void {
  changeListener = listener || null
}
