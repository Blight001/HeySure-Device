// tools/ — public API for the MCP tool catalog and dispatcher.
//
//   definitions.ts  — BROWSER_TOOLS schema, BROWSER_CAPABILITIES,
//                      BROWSER_TOOL_CATEGORIES (单一分组来源)
//   browser.ts      — browser_* tool implementations + executeBrowserOnly router
//   router.ts       — executeBrowserTool dispatcher
//   executor.ts     — executeTask: server-dispatched task runner with AI loop
//   overrides.ts    — effectiveToolDefs: server-pushed schemas + local fallbacks

export {
  BROWSER_TOOLS, BROWSER_CAPABILITIES, BROWSER_TOOL_CATEGORIES,
  BROWSER_TOOL_KIND_LABELS, browserToolCategory, browserToolKind, isToolEnabledByDefault,
} from './definitions'
export type { BrowserToolCategory, BrowserToolKind } from './definitions'
export { executeBrowserOnly } from './browser'
export { executeBrowserTool } from './router'
export { executeTask } from './executor'
export { allToolDefs, effectiveToolDefs, resolveToolEnabledMap, enabledToolNames } from './overrides'
export {
  BROWSER_DYNAMIC_MCP_MANAGER_NAME, DYNAMIC_MCP_MANAGER_NAME,
  DYNAMIC_MCP_STORAGE_KEY, getDynamicMcpDefinitions, isServerManagedToolDef,
} from './dynamic'
