// Tool registry — port of device/shared/src/executor/registry.ts. This shell
// is Windows-only, so the platform profile is a constant instead of a fork file.

export type ToolPlatform = 'all' | 'windows' | 'linux' | 'mac'

const PLATFORM: ToolPlatform = 'windows'
export const AGENT_NAME = 'Windows Agent'

export interface ToolHandlerArgs {
  workspaceRoot: string
  args: Record<string, any>
}

export type ToolHandler = (ctx: ToolHandlerArgs) => any | Promise<any>

export interface ToolDefinition {
  id: string
  platform: ToolPlatform
  handler: ToolHandler
  description?: string
  inputSchema?: Record<string, any>
  destructive?: boolean
  implementation?: Record<string, any>
}

export interface ToolDef {
  name: string
  description: string
  input_schema: Record<string, any>
  destructive?: boolean
  implementation?: Record<string, any>
}

const registry = new Map<string, ToolDefinition>()
const builtinTools = new Map<string, ToolDefinition>()
const dynamicToolIds = new Set<string>()

export function registerTool(def: ToolDefinition): void {
  registry.set(def.id, def)
  builtinTools.set(def.id, def)
}

export function registerTools(defs: ToolDefinition[]): void {
  for (const def of defs) registerTool(def)
}

export function replaceDynamicTools(defs: ToolDefinition[]): void {
  for (const id of dynamicToolIds) {
    const builtin = builtinTools.get(id)
    if (builtin) registry.set(id, builtin)
    else registry.delete(id)
  }
  dynamicToolIds.clear()
  for (const def of defs) {
    registry.set(def.id, def)
    dynamicToolIds.add(def.id)
  }
}

export function getTool(id: string): ToolDefinition | undefined {
  return registry.get(id)
}

export function getBuiltinTool(id: string): ToolDefinition | undefined {
  return builtinTools.get(id)
}

export function listBuiltinToolIds(): string[] {
  return Array.from(builtinTools.keys())
}

function isToolAvailable(t: ToolDefinition): boolean {
  return t.platform === 'all' || t.platform === PLATFORM
}

export function listToolIds(): string[] {
  return Array.from(registry.values())
    .filter(isToolAvailable)
    .map(t => t.id)
}

export function listToolDefs(): ToolDef[] {
  return Array.from(registry.values())
    .filter(isToolAvailable)
    .map(t => ({
      name: t.id,
      description: t.description || `Run desktop tool ${t.id} on the connected ${AGENT_NAME}.`,
      input_schema: t.inputSchema || { type: 'object', properties: {}, additionalProperties: true },
      destructive: !!t.destructive,
      implementation: t.implementation || {
        kind: dynamicToolIds.has(t.id) ? 'dynamic' : 'builtin',
        handler_source: String(t.handler),
        editable_via: 'mcp.manage_dynamic_tool',
      },
    }))
}
