// tools/ — public API for the MCP tool catalog and dispatcher.
//
//   definitions.ts  — BROWSER_TOOLS schema（仅端侧执行/展示参考，不再上报）、
//                      BROWSER_TOOL_CATEGORIES (单一分组来源)
//   browser.ts      — browser_* tool implementations + executeBrowserOnly router
//   router.ts       — executeBrowserTool dispatcher
//   executor.ts     — executeTask: server-dispatched task runner with AI loop
//   overrides.ts    — allToolDefs/effectiveToolDefs: 纯服务器驱动的动态工具目录

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
  DYNAMIC_MCP_STORAGE_KEY, DYNAMIC_MCP_SERVER_SESSION_KEY,
  getDynamicMcpDefinitions, isServerManagedToolDef,
} from './dynamic'
