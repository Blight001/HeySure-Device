// Tool registry — single source of truth for what the agent can execute.
// Each tool is one entry mapping a stable id (e.g. "desktop.tool") to:
//   - handler: async function that performs the work
//   - platform: which platforms the tool is available on
//
// Adding a new capability means appending one entry — no switch statement
// to touch and no parallel arrays to keep in sync.

import { platformProfile } from '../platform'

export type ToolPlatform = 'all' | 'windows' | 'linux' | 'mac'

export interface ToolHandlerArgs {
  workspaceRoot: string
  args: Record<string, any>
}

export type ToolHandler = (ctx: ToolHandlerArgs) => any | Promise<any>

export interface ToolDefinition {
  id: string
  platform: ToolPlatform
  handler: ToolHandler
  // Self-described MCP schema shipped to the server at register time. The
  // server stores these and surfaces them in mcp.list_tools / describe_tool
  // instead of hardcoding desktop tool schemas. Optional for back-compat.
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

// Ids of the device's native capability library. Server-authored JS tools call
// these via the injected ``cap`` object instead of the catalog exposing them as
// MCP tools directly.
export function listBuiltinToolIds(): string[] {
  return Array.from(builtinTools.keys())
}

function builtinSourceFiles(id: string): string[] {
  if (id === 'mcp.manage_dynamic_tool') {
    return ['src/executor/dynamic.ts', 'dist/executor/dynamic.js']
  }
  const namespace = String(id || '').split('.', 1)[0]
  return [
    'src/executor/catalog.ts',
    `src/tools/${namespace}.ts`,
    'dist/executor/catalog.js',
    `dist/tools/${namespace}.js`,
  ]
}

function isToolAvailable(t: ToolDefinition): boolean {
  return t.platform === 'all'
    || (t.platform === platformProfile.platform && platformProfile.isCurrentPlatform)
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
      description: t.description || `Run desktop tool ${t.id} on the connected ${platformProfile.agentName}.`,
      input_schema: t.inputSchema || { type: 'object', properties: {}, additionalProperties: true },
      destructive: !!t.destructive,
      implementation: t.implementation || {
        kind: dynamicToolIds.has(t.id) ? 'dynamic' : 'builtin',
        source_files: builtinSourceFiles(t.id),
        handler_source: String(t.handler),
        editable_via: 'mcp.manage_dynamic_tool',
      },
    }))
}
