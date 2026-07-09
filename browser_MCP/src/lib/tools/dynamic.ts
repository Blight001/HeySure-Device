import { AIToolDef } from '../types'
import { BROWSER_TOOLS } from './definitions'

export interface DynamicMcpDefinition {
  name: string
  description: string
  input_schema: { type: 'object'; properties: Record<string, any>; required?: string[] }
  code: DynamicInstruction[]
}
type DynamicInstruction = { op: 'call' | 'set' | 'return'; tool?: string; args?: any; name?: string; value?: any; save_as?: string }

export const DYNAMIC_MCP_STORAGE_KEY = '_dynamic_mcp_tools'
// Legacy key — server tools used to be cached in chrome.storage.local; purge once.
export const DYNAMIC_MCP_SERVER_STORAGE_KEY = '_dynamic_mcp_server_tools'
// Server-pushed tools (device:tool-config) live in chrome.storage.session, NOT a
// module variable: the popup runs in a SEPARATE JS context from the background
// service worker, so a module var would only ever be populated in the worker that
// owns the socket — the popup's MCP list would then show nothing. storage.session
// is shared across all extension contexts and is in-memory (never written to disk,
// cleared when the browser closes), matching the "server tools never persist"
// intent. It also survives MV3 worker teardown, so the reported catalog no longer
// briefly collapses to the bootstrap when the worker is recycled.
// Shape: { revision: string, tools: DynamicMcpDefinition[] }.
export const DYNAMIC_MCP_SERVER_SESSION_KEY = '_dynamic_mcp_server_session'
export const DYNAMIC_MCP_MANAGER_NAME = 'mcp.manage_dynamic_tool'
export const BROWSER_DYNAMIC_MCP_MANAGER_NAME = 'browser_mcp.manage_dynamic_tool'
const NAME_RE = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/

function isManagerName(name: string): boolean {
  return name === DYNAMIC_MCP_MANAGER_NAME || name === BROWSER_DYNAMIC_MCP_MANAGER_NAME
}

function revision(value: any): string {
  const text = JSON.stringify(value)
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function validate(raw: any): DynamicMcpDefinition {
  const name = String(raw?.name || '').trim()
  if (!NAME_RE.test(name)) throw new Error(`Invalid dynamic MCP name: ${name || '(empty)'}`)
  if (isManagerName(name)) throw new Error(`${name} is reserved`)
  const description = String(raw?.description || '').trim()
  if (!description) throw new Error(`Dynamic MCP ${name} requires description`)
  const inputSchema = raw?.input_schema ?? raw?.inputSchema
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) throw new Error(`Dynamic MCP ${name} requires input_schema`)
  const code = typeof raw?.code === 'string' ? JSON.parse(raw.code) : raw?.code
  if (!Array.isArray(code) || !code.length || code.length > 32) throw new Error(`Dynamic MCP ${name} code must contain 1-32 instructions`)
  for (const step of code) {
    if (!step || !['call', 'set', 'return'].includes(step.op)) throw new Error(`Invalid instruction in ${name}`)
    if (step.op === 'call' && !String(step.tool || '').trim()) throw new Error(`call instruction in ${name} requires tool`)
    if (step.op === 'set' && !String(step.name || '').trim()) throw new Error(`set instruction in ${name} requires name`)
  }
  return { name, description, input_schema: inputSchema, code }
}

export async function getDynamicMcpDefinitions(): Promise<DynamicMcpDefinition[]> {
  const stored = (await chrome.storage.local.get(DYNAMIC_MCP_STORAGE_KEY))[DYNAMIC_MCP_STORAGE_KEY]
  const list = Array.isArray(stored) ? stored : stored?.tools
  if (list == null) return []
  if (!Array.isArray(list)) throw new Error('Dynamic MCP storage must contain a tools array')
  const tools = list.map(validate)
  if (new Set(tools.map(item => item.name)).size !== tools.length) throw new Error('Duplicate dynamic MCP name')
  return tools
}

async function saveDynamicMcpDefinitions(tools: DynamicMcpDefinition[]): Promise<void> {
  await chrome.storage.local.set({ [DYNAMIC_MCP_STORAGE_KEY]: { version: 1, tools } })
}

async function readServerSession(): Promise<{ revision: string; tools: DynamicMcpDefinition[] }> {
  try {
    const stored = (await chrome.storage.session.get(DYNAMIC_MCP_SERVER_SESSION_KEY))[DYNAMIC_MCP_SERVER_SESSION_KEY]
    const tools = Array.isArray(stored?.tools) ? (stored.tools as DynamicMcpDefinition[]) : []
    const rev = typeof stored?.revision === 'string' ? stored.revision : ''
    return { revision: rev, tools }
  } catch {
    return { revision: '', tools: [] }
  }
}

export async function getServerDynamicMcpDefinitions(): Promise<DynamicMcpDefinition[]> {
  return (await readServerSession()).tools
}

async function purgeLegacyServerCache(): Promise<void> {
  await chrome.storage.local.remove(DYNAMIC_MCP_SERVER_STORAGE_KEY)
}

export async function clearServerDynamicMcp(): Promise<{ cleared: boolean; tools: number; server: number }> {
  const current = await readServerSession()
  const hadServer = current.tools.length > 0 || !!current.revision
  await chrome.storage.session.remove(DYNAMIC_MCP_SERVER_SESSION_KEY)
  const { merged } = await getMergedDynamicMcpDefinitions()
  return { cleared: hadServer, tools: merged.length, server: 0 }
}

void purgeLegacyServerCache()

// Local + server tools merged, server winning on a name conflict. Used for both
// advertising (dynamicMcpToolDefs) and execution (executeDynamicMcp) so the two
// never drift.
async function getMergedDynamicMcpDefinitions(): Promise<{ merged: DynamicMcpDefinition[]; serverNames: Set<string> }> {
  const [local, server] = await Promise.all([getDynamicMcpDefinitions(), getServerDynamicMcpDefinitions()])
  const serverNames = new Set(server.map(item => item.name))
  const byName = new Map<string, DynamicMcpDefinition>()
  for (const def of local) byName.set(def.name, def)
  for (const def of server) byName.set(def.name, def)
  return { merged: Array.from(byName.values()), serverNames }
}

// Apply a server-pushed dynamic MCP set (device:tool-config). Returns
// applied:false when the set is unchanged — the guard stops the
// register→push→apply loop (applying re-registers, the server re-pushes).
export async function applyServerDynamicMcp(payload: any): Promise<{ applied: boolean; revision: string; tools: number }> {
  const list = Array.isArray(payload) ? payload : payload?.tools
  const tools = Array.isArray(list) ? list.map(validate) : []
  if (new Set(tools.map(item => item.name)).size !== tools.length) throw new Error('Duplicate dynamic MCP name')
  const rev = revision(tools)
  const current = await readServerSession()
  if (rev === current.revision) return { applied: false, revision: rev, tools: tools.length }
  await chrome.storage.session.set({ [DYNAMIC_MCP_SERVER_SESSION_KEY]: { revision: rev, tools } })
  return { applied: true, revision: rev, tools: tools.length }
}

function lookup(root: any, dotted: string): any {
  return dotted.split('.').filter(Boolean).reduce((value, key) => value == null ? undefined : value[key], root)
}

function render(value: any, context: Record<string, any>): any {
  if (Array.isArray(value)) return value.map(item => render(item, context))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, render(item, context)]))
  if (typeof value !== 'string') return value
  const exact = value.match(/^\$\{([^}]+)\}$/)
  if (exact) return lookup(context, exact[1])
  return value.replace(/\$\{([^}]+)\}/g, (_all, expr) => {
    const found = lookup(context, expr)
    return found == null ? '' : typeof found === 'string' ? found : JSON.stringify(found)
  })
}

async function runProgram(
  def: DynamicMcpDefinition,
  args: Record<string, any>,
  callTool: (name: string, args: any) => Promise<any>,
  callBuiltin: (name: string, args: any) => Promise<any>,
  all: DynamicMcpDefinition[],
  depth = 0,
): Promise<any> {
  if (depth > 8) throw new Error('Dynamic MCP call depth exceeded')
  const context: Record<string, any> = { args, vars: {}, last: null, workspaceRoot: '' }
  for (const step of def.code) {
    if (step.op === 'set') { context.vars[String(step.name)] = render(step.value, context); continue }
    if (step.op === 'return') return render(step.value, context)
    const target = String(render(step.tool || '', context) || '').trim()
    if (isManagerName(target)) throw new Error('Dynamic MCP code cannot invoke the management tool')
    const builtinTarget = target.startsWith('builtin:') ? target.slice('builtin:'.length) : ''
    const childArgs = render(step.args || {}, context)
    const child = all.find(item => item.name === target)
    const result = builtinTarget
      ? await callBuiltin(builtinTarget, childArgs)
      : child
        ? await runProgram(child, childArgs, callTool, callBuiltin, all, depth + 1)
        : await callTool(target, childArgs)
    context.last = result
    if (step.save_as) context.vars[String(step.save_as)] = result
  }
  return context.last
}

export async function executeDynamicMcp(
  name: string,
  args: Record<string, any>,
  callTool: (name: string, args: any) => Promise<any>,
  callBuiltin: (name: string, args: any) => Promise<any>,
): Promise<{ handled: boolean; result?: any }> {
  if (isManagerName(name)) return { handled: true, result: await manageDynamicMcp(args) }
  const { merged } = await getMergedDynamicMcpDefinitions()
  const def = merged.find(item => item.name === name)
  if (!def) return { handled: false }
  return { handled: true, result: await runProgram(def, args || {}, callTool, callBuiltin, merged) }
}

const BROWSER_SOURCE_FILES = ['src/lib/tools/definitions.ts', 'src/lib/tools/browser.ts', 'src/lib/tools/router.ts', 'dist/background.js']

function sourceFilesForTool(name: string): string[] {
  return isManagerName(name) ? ['src/lib/tools/dynamic.ts', 'dist/background.js'] : BROWSER_SOURCE_FILES
}

async function readExtensionSource(requested: string): Promise<Record<string, any>> {
  const relative = String(requested || '').trim().replace(/\\/g, '/')
  if (!relative || relative.startsWith('/') || relative.split('/').includes('..') || !/^(src|dist)\//.test(relative)) {
    throw new Error('source_path must be a relative src/ or dist/ path inside the extension')
  }
  const response = await fetch(chrome.runtime.getURL(relative))
  if (!response.ok) throw new Error(`Source file not found: ${relative}`)
  const content = await response.text()
  if (content.length > 256 * 1024) throw new Error(`Source file is too large to inspect: ${relative}`)
  return { path: relative, content, size: content.length }
}

async function readToolSources(name: string): Promise<Record<string, any>[]> {
  const sources: Record<string, any>[] = []
  for (const sourcePath of sourceFilesForTool(name)) {
    try { sources.push(await readExtensionSource(sourcePath)) } catch { /* optional source variant */ }
  }
  return sources
}

async function inspectTool(name: string, all: DynamicMcpDefinition[], includeSource = true): Promise<Record<string, any>> {
  const dynamic = all.find(item => item.name === name)
  const builtin = BROWSER_TOOLS.find(item => item.name === name)
  if (!dynamic && !builtin && !isManagerName(name)) throw new Error(`MCP tool not found: ${name}`)
  const active = dynamic || builtin || BROWSER_DYNAMIC_MCP_MANAGER_DEF
  return {
    ok: true,
    name,
    implementation_kind: dynamic ? 'dynamic_override' : 'builtin',
    active_definition: active,
    source_files: sourceFilesForTool(name),
    sources: includeSource ? await readToolSources(name) : undefined,
    dynamic_storage_key: DYNAMIC_MCP_STORAGE_KEY,
    edit_workflow: [
      `Call ${BROWSER_DYNAMIC_MCP_MANAGER_NAME} action=get_source with a tool name to read the packaged implementation.`,
      `Call ${BROWSER_DYNAMIC_MCP_MANAGER_NAME} action=upsert with starter_definition or a revised definition.`,
      `Use builtin:${name} inside a call instruction to wrap the original implementation.`,
      `Call ${BROWSER_DYNAMIC_MCP_MANAGER_NAME} action=delete to restore the built-in implementation.`,
    ],
    starter_definition: dynamic || {
      name,
      description: active.description || `Dynamic override for ${name}`,
      input_schema: active.input_schema || { type: 'object', properties: {} },
      code: [
        { op: 'call', tool: `builtin:${name}`, args: '${args}', save_as: 'original_result' },
        { op: 'return', value: '${vars.original_result}' },
      ],
    },
  }
}

export async function manageDynamicMcp(args: Record<string, any>): Promise<any> {
  const action = String(args?.action || 'list').trim().toLowerCase()
  const all = await getDynamicMcpDefinitions()
  if (action === 'reload') return { ok: true, tools: all.length, revision: revision(all) }
  if (action === 'list') return { ok: true, revision: revision(all), tools: all.map(item => ({ name: item.name, description: item.description, revision: revision(item) })) }
  const name = String(args?.name || args?.definition?.name || '').trim()
  if (action === 'get_source') {
    const requested = String(args?.source_path || '').trim()
    const sources: Record<string, any>[] = []
    if (requested) {
      try { sources.push(await readExtensionSource(requested)) } catch (err) {
        if (!name) throw err
      }
    }
    if (name) {
      const seen = new Set(sources.map(source => source.path))
      for (const source of await readToolSources(name)) {
        if (!seen.has(source.path)) sources.push(source)
      }
    }
    if (!sources.length) throw new Error('get_source requires name or a readable source_path')
    return { ok: true, name: name || undefined, requested_path: requested || undefined, source: sources[0], sources }
  }
  if (!name) throw new Error('name is required')
  if (action === 'inspect') return inspectTool(name, all, args?.include_source !== false)
  if (action === 'upsert' || action === 'delete') {
    // Server-pushed tools for this device type are managed from the web console.
    const serverNames = new Set((await getServerDynamicMcpDefinitions().catch(() => [])).map(item => item.name))
    if (serverNames.has(name)) throw new Error(`${name} is managed from the web console for this device type`)
  }
  const current = all.find(item => item.name === name)
  if (action === 'get') {
    if (!current) throw new Error(`Dynamic MCP not found: ${name}`)
    return { ok: true, definition: current, revision: revision(current) }
  }
  if (args?.expected_revision && current && args.expected_revision !== revision(current)) throw new Error(`Dynamic MCP changed since it was read: ${name}`)
  let next: DynamicMcpDefinition[]
  if (action === 'delete') {
    if (!current) throw new Error(`Dynamic MCP not found: ${name}`)
    next = all.filter(item => item.name !== name)
  } else if (action === 'upsert') {
    const nextDef = validate({ ...(args.definition || {}), name })
    next = [...all.filter(item => item.name !== name), nextDef].sort((a, b) => a.name.localeCompare(b.name))
  } else throw new Error(`Unsupported action: ${action}`)
  await saveDynamicMcpDefinitions(next)
  return { ok: true, action, name, tools: next.length, revision: revision(next) }
}

export const DYNAMIC_MCP_MANAGER_DEF: AIToolDef = {
  name: DYNAMIC_MCP_MANAGER_NAME,
  description: '动态管理本浏览器设备的传承 MCP 代码。可读取、创建、更新、删除并热加载 JSON 程序工具；使用现有工具名可覆盖内置实现，删除后恢复内置版本；保存后会立即向服务器重新上报工具目录。',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'inspect', 'get_source', 'upsert', 'delete', 'reload'], description: '管理动作。inspect 默认返回实现源码；get_source 可按工具名读取全部相关源码。' },
      name: { type: 'string', description: 'MCP 名称，如 browser_action 或 custom.collect_page。get_source 只传名称即可读取源码。' },
      source_path: { type: 'string', description: '可选相对源码路径；读取失败但提供 name 时会自动按工具名查找。' },
      include_source: { type: 'boolean', description: 'inspect 是否附带完整源码，默认 true。' },
      expected_revision: { type: 'string', description: 'get 返回的修订哈希；更新/删除时用于防止覆盖并发修改。' },
      definition: {
        type: 'object', description: 'upsert 使用的完整动态 MCP 定义。',
        properties: {
          name: { type: 'string', description: '工具名；与内置工具同名时覆盖内置实现。' },
          description: { type: 'string', description: '向 AI 展示的工具说明。' },
          input_schema: { type: 'object', description: 'JSON Schema 入参定义。' },
          code: { type: 'array', minItems: 1, maxItems: 32, description: 'call/set/return 指令；模板支持 ${args.x}、${vars.x}、${last.x}。', items: { type: 'object' } },
        }, required: ['name', 'description', 'input_schema', 'code'],
      },
    },
    required: ['action'],
  },
  implementation: {
    kind: 'builtin_manager',
    source_files: ['src/lib/tools/dynamic.ts', 'dist/background.js'],
    editable_via: DYNAMIC_MCP_MANAGER_NAME,
  },
}

export const BROWSER_DYNAMIC_MCP_MANAGER_DEF: AIToolDef = {
  ...DYNAMIC_MCP_MANAGER_DEF,
  name: BROWSER_DYNAMIC_MCP_MANAGER_NAME,
  description: '动态管理本浏览器设备的传承 MCP 代码。可读取浏览器工具源码、创建或覆盖工具，并在保存后立即热加载和重新上报。',
  implementation: {
    ...DYNAMIC_MCP_MANAGER_DEF.implementation,
    editable_via: BROWSER_DYNAMIC_MCP_MANAGER_NAME,
  },
}

export function isServerManagedToolDef(tool: AIToolDef): boolean {
  const impl = tool.implementation
  if (!impl || typeof impl !== 'object') return false
  return impl.source === 'server' || impl.storage_key === 'memory:server'
}

export async function dynamicMcpToolDefs(): Promise<AIToolDef[]> {
  const { merged, serverNames } = await getMergedDynamicMcpDefinitions()
  return [BROWSER_DYNAMIC_MCP_MANAGER_DEF, ...merged.map(def => {
    const fromServer = serverNames.has(def.name)
    return {
      name: def.name,
      description: def.description,
      input_schema: def.input_schema,
      implementation: {
        kind: 'dynamic',
        definition: def,
        code: def.code,
        storage_key: fromServer ? 'memory:server' : DYNAMIC_MCP_STORAGE_KEY,
        source: fromServer ? 'server' : 'local',
        editable_via: BROWSER_DYNAMIC_MCP_MANAGER_NAME,
      },
    }
  })]
}
