// tools/overrides.ts — build the MCP catalog the extension reports to the server.
//
// 纯服务器驱动（对齐 Windows 桌面端）：广告给服务器的工具目录 = 动态工具集：
//   1. browser_mcp.manage_dynamic_tool 引导器——唯一的本地内置项，负责加载服务器下发的工具；
//   2. 服务器经 device:tool-config 下发的浏览器工具（program 包装器，memory-only）；
//   3. 本地经 manager 创作的动态工具（chrome.storage）。
// 硬编码的 BROWSER_TOOLS 不再作为上报目录——所有浏览器工具的 schema 一律以服务器
// 工作区 device_tools/browser/ 下发为准。BROWSER_TOOLS 仅保留在 browser.ts 里作为
// builtin:* 的端侧执行实现（服务器下发的 program 包装器通过 builtin:browser_* 调用）。
//
// 工具启停仍存 chrome.storage（桌面端在 store 里有等价物）。服务器托管工具不套用
// 本地描述改写——请在服务器 / Web 控制台修改。

import { isToolEnabledByDefault } from './definitions'
import { AIToolDef } from '../types'
import { getToolDescOverrides, getToolEnabledMap } from '../storage'
import { dynamicMcpToolDefs, isServerManagedToolDef } from './dynamic'

export async function allToolDefs(): Promise<AIToolDef[]> {
  // 上报目录 = 动态工具集（manager 引导器 + 服务器下发 + 本地创作），不再合并硬编码
  // BROWSER_TOOLS。首次连接、服务器尚未下发前，这里只有 manager 引导器（与桌面端一致）。
  return await dynamicMcpToolDefs()
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