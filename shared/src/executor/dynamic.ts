import crypto from 'crypto'
import fs, { FSWatcher } from 'fs'
import path from 'path'
import { app } from 'electron'
import { getBuiltinTool, getTool, listBuiltinToolIds, replaceDynamicTools, ToolDefinition } from './registry'
import { runRuntimeTool, isToolRuntime, type ToolRuntime } from '../runtime/runtime-tool'

export interface DynamicMcpDefinition {
  name: string
  description: string
  input_schema: Record<string, any>
  // 'program' → run the call/set/return DSL in ``code``.
  // 'js'      → run ``js`` (a function body) with (args, cap, ctx) in scope.
  // 'runtime' → run ``source`` via a device runtime (python/powershell/shell).
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

const MANAGER_TOOL = 'mcp.manage_dynamic_tool'
const NAME_RE = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/
// Merged set (local + server) used at runtime for child-tool resolution.
let definitions: DynamicMcpDefinition[] = []
// Locally-authored tools (via mcp.manage_dynamic_tool); persisted to filePath.
let localDefinitions: DynamicMcpDefinition[] = []
// Web-authored tools pushed by the server (device:tool-config), scoped by
// device type; held in memory only (no disk cache). The server owns them —
// the manager never edits them. Cleared on disconnect so stale tools cannot
// outlive the server session.
let serverDefinitions: DynamicMcpDefinition[] = []
let appliedServerRevision = ''
let filePath = ''
let legacyServerCachePath = ''
let watcher: FSWatcher | null = null
let changeListener: (() => void) | null = null
let reloadTimer: NodeJS.Timeout | null = null

function revision(value: any): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function validate(raw: any): DynamicMcpDefinition {
  const name = String(raw?.name || '').trim()
  if (!NAME_RE.test(name)) throw new Error(`Invalid dynamic MCP name: ${name || '(empty)'}`)
  if (name === MANAGER_TOOL) throw new Error(`${MANAGER_TOOL} is reserved`)
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

// The native capability library injected into server-authored JS tools. Each
// device built-in is reachable via ``cap.call(id, args)`` and an ergonomic
// ``cap.<namespace>.<fn>(args)`` shape. This is what lets the hardcoded catalog
// stop being MCP tools while their native code keeps running on the device.
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
    if (target === MANAGER_TOOL) throw new Error('Dynamic MCP code cannot invoke the management tool')
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

function asTool(def: DynamicMcpDefinition, fromServer = false): ToolDefinition {
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
      storage_file: fromServer ? 'memory:server' : filePath,
      source: fromServer ? 'server' : 'local',
      editable_via: MANAGER_TOOL,
    },
    handler: ({ workspaceRoot, args }) =>
      def.code_kind === 'runtime'
        ? runRuntimeTool(
            { name: def.name, runtime: def.runtime as ToolRuntime, source: def.source || '', permissions: def.permissions, description: def.description },
            workspaceRoot, args || {})
        : def.code_kind === 'js' ? runJs(def, workspaceRoot, args || {}) : runProgram(def, workspaceRoot, args || {}),
  }
}

function sourceFilesForTool(name: string): string[] {
  if (name === MANAGER_TOOL) return ['src/executor/dynamic.ts']
  const namespace = String(name || '').split('.', 1)[0]
  return ['src/executor/catalog.ts', `src/tools/${namespace}.ts`]
}

function sourceCandidates(relative: string): string[] {
  const candidates = [relative]
  const sourceMatch = relative.match(/^src\/(.+)\.tsx?$/i)
  if (sourceMatch) candidates.push(`dist/${sourceMatch[1]}.js`)
  return Array.from(new Set(candidates))
}

type ResolvedSource = {
  requested_path: string
  path: string
  root: string
  absolute_path: string
  fallback: boolean
}

function sourceRoots(): string[] {
  const roots: string[] = []
  const add = (value?: string) => {
    if (!value) return
    const resolved = path.resolve(value)
    if (!roots.includes(resolved)) roots.push(resolved)
  }
  try { add(app.getAppPath()) } catch {}
  add(process.cwd())
  add(path.resolve(__dirname, '..', '..'))
  if (process.resourcesPath) {
    add(process.resourcesPath)
    add(path.join(process.resourcesPath, 'app'))
    add(path.join(process.resourcesPath, 'app.asar'))
    add(path.join(process.resourcesPath, 'app.asar.unpacked'))
  }
  try {
    const exeDir = path.dirname(app.getPath('exe'))
    add(exeDir)
    add(path.dirname(exeDir))
  } catch {}
  return roots
}

function resolveReadableSource(requested: string): ResolvedSource | null {
  for (const root of sourceRoots()) {
    for (const candidate of sourceCandidates(requested)) {
      const resolved = path.resolve(root, candidate)
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) continue
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        return { requested_path: requested, path: candidate, root, absolute_path: resolved, fallback: candidate !== requested }
      }
    }
  }
  return null
}

function readAppSource(requested: string): Record<string, any> {
  const relative = String(requested || '').trim().replace(/\\/g, '/')
  if (!relative || path.isAbsolute(relative) || relative.split('/').includes('..')) {
    throw new Error('source_path must be a relative path inside the device application')
  }
  const source = resolveReadableSource(relative)
  if (!source) {
    const attempted = sourceRoots().flatMap(root => sourceCandidates(relative).map(candidate => path.resolve(root, candidate)))
    throw new Error(`Source file not found: ${relative}. Tried: ${attempted.join(', ')}`)
  }
  const size = fs.statSync(source.absolute_path).size
  if (size > 256 * 1024) throw new Error(`Source file is too large to inspect: ${source.path}`)
  return { ...source, content: fs.readFileSync(source.absolute_path, 'utf8'), size }
}

function readToolSources(name: string): Record<string, any>[] {
  const seen = new Set<string>()
  const sources: Record<string, any>[] = []
  for (const requested of sourceFilesForTool(name)) {
    const resolved = resolveReadableSource(requested)
    if (!resolved || seen.has(resolved.absolute_path)) continue
    seen.add(resolved.absolute_path)
    sources.push(readAppSource(requested))
  }
  return sources
}

function inspectTool(name: string, includeSource = true): Record<string, any> {
  const dynamic = definitions.find(item => item.name === name)
  const active = getTool(name)
  const builtin = getBuiltinTool(name)
  if (!active && !builtin) throw new Error(`MCP tool not found: ${name}`)
  const sourceFiles = sourceFilesForTool(name)
  const availableSources = sourceFiles.map(resolveReadableSource).filter(Boolean)
  return {
    ok: true,
    name,
    implementation_kind: dynamic ? 'dynamic_override' : 'builtin',
    active_definition: dynamic || {
      name,
      description: active?.description || builtin?.description || '',
      input_schema: active?.inputSchema || builtin?.inputSchema || {},
    },
    active_handler_source: String(active?.handler || ''),
    builtin_handler_source: builtin ? String(builtin.handler) : null,
    source_files: sourceFiles,
    available_source_files: availableSources.map(item => item!.path),
    source_resolution: availableSources,
    source_roots: sourceRoots(),
    sources: includeSource ? readToolSources(name) : undefined,
    dynamic_storage_file: filePath,
    edit_workflow: [
      `Call ${MANAGER_TOOL} action=get_source for a source_files path to read the implementation.`,
      `Call ${MANAGER_TOOL} action=upsert with starter_definition or a revised definition.`,
      `Use builtin:${name} inside a call instruction to wrap the original implementation.`,
      `Call ${MANAGER_TOOL} action=delete to remove the override and restore the built-in implementation.`,
    ],
    starter_definition: dynamic || {
      name,
      description: active?.description || builtin?.description || `Dynamic override for ${name}`,
      input_schema: active?.inputSchema || builtin?.inputSchema || { type: 'object', properties: {} },
      code: [
        { op: 'call', tool: `builtin:${name}`, args: '${args}', save_as: 'original_result' },
        { op: 'return', value: '${vars.original_result}' },
      ],
    },
  }
}

function ensurePaths(): void {
  if (!filePath) filePath = path.join(app.getPath('userData'), 'dynamic-mcp-tools.json')
  if (!legacyServerCachePath) {
    legacyServerCachePath = path.join(app.getPath('userData'), 'dynamic-mcp-tools.server.json')
  }
}

function purgeLegacyServerCache(): void {
  ensurePaths()
  if (!legacyServerCachePath || !fs.existsSync(legacyServerCachePath)) return
  try { fs.unlinkSync(legacyServerCachePath) } catch { /* best-effort */ }
}

function readToolsFile(target: string): DynamicMcpDefinition[] {
  if (!target || !fs.existsSync(target)) return []
  const raw = JSON.parse(fs.readFileSync(target, 'utf8'))
  const list = Array.isArray(raw) ? raw : raw?.tools
  if (list == null) return []
  if (!Array.isArray(list)) throw new Error(`${path.basename(target)} must contain a tools array`)
  const next = list.map(validate)
  const names = new Set<string>()
  for (const item of next) {
    if (names.has(item.name)) throw new Error(`Duplicate dynamic MCP: ${item.name}`)
    names.add(item.name)
  }
  return next
}

function persist(next: DynamicMcpDefinition[]): void {
  const temp = `${filePath}.tmp`
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(temp, JSON.stringify({ version: 1, tools: next }, null, 2), 'utf8')
  fs.renameSync(temp, filePath)
}

function mergeAndApply(): { tools: number; local: number; server: number; revision: string; file: string } {
  const serverNames = new Set(serverDefinitions.map(item => item.name))
  const merged = new Map<string, DynamicMcpDefinition>()
  for (const def of localDefinitions) merged.set(def.name, def)
  for (const def of serverDefinitions) merged.set(def.name, def)
  const next = Array.from(merged.values())
  replaceDynamicTools(next.map(def => asTool(def, serverNames.has(def.name))))
  definitions = next
  return {
    tools: next.length,
    local: localDefinitions.length,
    server: serverDefinitions.length,
    revision: revision(next),
    file: filePath,
  }
}

export function reloadDynamicMcp(): { tools: number; local: number; server: number; revision: string; file: string } {
  ensurePaths()
  localDefinitions = readToolsFile(filePath)
  return mergeAndApply()
}

// Drop server-pushed tools from memory (e.g. on disconnect). Local tools
// created via mcp.manage_dynamic_tool are untouched.
export function clearServerDynamicMcp(): { cleared: boolean; tools: number; server: number } {
  const hadServer = serverDefinitions.length > 0 || !!appliedServerRevision
  serverDefinitions = []
  appliedServerRevision = ''
  const status = mergeAndApply()
  if (hadServer) changeListener?.()
  return { cleared: hadServer, tools: status.tools, server: status.server }
}

// Apply a server-pushed dynamic MCP set (device:tool-config). Returns
// applied:false when the set is unchanged — this guard stops the
// register→push→apply loop, since applying re-registers and the server
// re-pushes the same set.
export function applyServerDynamicMcp(payload: any): { applied: boolean; revision: string; tools: number } {
  const list = Array.isArray(payload) ? payload : payload?.tools
  const tools = Array.isArray(list) ? list.map(validate) : []
  const names = new Set<string>()
  for (const item of tools) {
    if (names.has(item.name)) throw new Error(`Duplicate dynamic MCP: ${item.name}`)
    names.add(item.name)
  }
  const rev = revision(tools)
  if (rev === appliedServerRevision) return { applied: false, revision: rev, tools: tools.length }
  serverDefinitions = tools
  appliedServerRevision = rev
  mergeAndApply()
  changeListener?.()
  return { applied: true, revision: rev, tools: tools.length }
}

function scheduleReload(): void {
  if (reloadTimer) clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => {
    try {
      reloadDynamicMcp()
      changeListener?.()
    } catch (err) {
      console.error('Dynamic MCP reload failed:', err)
    }
  }, 120)
}

export function initializeDynamicMcp(listener?: () => void): void {
  changeListener = listener || null
  purgeLegacyServerCache()
  reloadDynamicMcp()
  watcher?.close()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  watcher = fs.watch(path.dirname(filePath), (_event, filename) => {
    if (String(filename || '') === path.basename(filePath)) scheduleReload()
  })
}

export async function manageDynamicMcp(args: Record<string, any>): Promise<any> {
  const action = String(args?.action || 'list').trim().toLowerCase()
  if (action === 'reload') return { ok: true, ...reloadDynamicMcp() }
  if (action === 'list') return {
    ok: true,
    file: filePath,
    revision: revision(localDefinitions),
    tools: localDefinitions.map(item => ({ name: item.name, description: item.description, revision: revision(item) })),
  }
  const name = String(args?.name || args?.definition?.name || '').trim()
  if (action === 'get_source') {
    const requested = String(args?.source_path || '').trim()
    const sources: Record<string, any>[] = []
    const seen = new Set<string>()
    let requestedError: Error | null = null
    if (requested) {
      try {
        const source = readAppSource(requested)
        sources.push(source)
        seen.add(source.absolute_path)
      } catch (err) {
        requestedError = err instanceof Error ? err : new Error(String(err))
      }
    }
    if (name) {
      for (const source of readToolSources(name)) {
        if (!seen.has(source.absolute_path)) sources.push(source)
        seen.add(source.absolute_path)
      }
    }
    if (!sources.length) {
      if (requestedError) throw requestedError
      throw new Error('get_source requires name or source_path')
    }
    return { ok: true, name: name || undefined, requested_path: requested || undefined, source: sources[0], sources, source_roots: sourceRoots() }
  }
  if (!name) throw new Error('name is required')
  if (action === 'inspect') return inspectTool(name, args?.include_source !== false)
  // The manager edits only locally-authored tools. Server-pushed tools for this
  // device type are managed from the web console, never here.
  const current = localDefinitions.find(item => item.name === name)
  if (action === 'get') {
    if (!current) throw new Error(`Dynamic MCP not found: ${name}`)
    return { ok: true, definition: current, revision: revision(current), file: filePath }
  }
  if (args?.expected_revision && current && args.expected_revision !== revision(current)) {
    throw new Error(`Dynamic MCP changed since it was read: ${name}`)
  }
  if (action === 'delete') {
    if (!current) throw new Error(`Dynamic MCP not found: ${name}`)
    persist(localDefinitions.filter(item => item.name !== name))
  } else if (action === 'upsert') {
    if (serverDefinitions.some(item => item.name === name)) {
      throw new Error(`${name} is managed from the web console for this device type`)
    }
    const nextDef = validate({ ...(args.definition || {}), name })
    persist([...localDefinitions.filter(item => item.name !== name), nextDef].sort((a, b) => a.name.localeCompare(b.name)))
  } else {
    throw new Error(`Unsupported action: ${action}`)
  }
  const status = reloadDynamicMcp()
  changeListener?.()
  return { ok: true, action, name, ...status }
}

export const DYNAMIC_MCP_MANAGER_DEFINITION: ToolDefinition = {
  id: MANAGER_TOOL,
  platform: 'all',
  destructive: true,
  description: '动态管理本设备的传承 MCP 代码。可读取、创建、更新、删除并热加载 JSON 程序工具；使用现有工具名可覆盖内置实现，删除后恢复内置版本；保存后设备会立即向服务器重新上报工具目录。',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'inspect', 'get_source', 'upsert', 'delete', 'reload'], description: '管理动作。inspect 默认直接返回任意工具的注册与实现源码；get_source 可按工具名读取全部相关源码。' },
      name: { type: 'string', description: 'MCP 名称，如 keyboard.type；get_source 只传名称即可读取注册代码和底层实现。' },
      source_path: { type: 'string', description: '可选的相对源码路径。读取失败但同时提供 name 时，会自动按工具名查找实际源码。' },
      include_source: { type: 'boolean', description: 'inspect 是否附带完整源码内容，默认 true。' },
      expected_revision: { type: 'string', description: 'get 返回的修订哈希；更新/删除时用于防止覆盖并发修改。' },
      definition: {
        type: 'object', description: 'upsert 使用的完整动态 MCP 定义。',
        properties: {
          name: { type: 'string', description: '工具名；与内置工具同名时覆盖内置实现。' },
          description: { type: 'string', description: '向 AI 展示的工具说明。' },
          input_schema: { type: 'object', description: 'JSON Schema 入参定义。' },
          code: {
            type: 'array', minItems: 1, maxItems: 32, description: '顺序执行的程序指令。',
            items: { type: 'object', properties: {
              op: { type: 'string', enum: ['call', 'set', 'return'] },
              tool: { type: 'string', description: 'call 的目标 MCP。' },
              args: { type: 'object', description: 'call 参数；支持 ${args.x}、${vars.x}、${last.x} 模板。' },
              name: { type: 'string', description: 'set 写入的变量名。' },
              value: { description: 'set/return 的值或模板。' },
              save_as: { type: 'string', description: '把 call 结果保存到 vars.<name>。' },
            }, required: ['op'] },
          },
          runtime: { type: 'string', enum: ['python', 'powershell', 'shell'], description: '运行时类型；设置后改用 source 提供源码（程序/JS 工具留空）。' },
          source: { type: 'string', description: 'runtime 工具源码：python 脚本（用 args 取参、result 返回）/ powershell 脚本 / shell 命令，支持 ${args.x} 模板。' },
          permissions: { type: 'array', items: { type: 'string' }, description: 'runtime 工具声明的权限标签，本机按策略 allow/confirm/deny。' },
        }, required: ['name', 'description', 'input_schema'],
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  implementation: {
    kind: 'builtin_manager',
    source_files: ['src/executor/dynamic.ts', 'dist/executor/dynamic.js'],
    editable_via: MANAGER_TOOL,
  },
  handler: ({ args }) => manageDynamicMcp(args),
}
