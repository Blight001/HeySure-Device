// tools/overrides.ts — build the MCP catalog the extension reports to the server.
//
// 纯服务器驱动：广告给服务器的工具目录 = 动态工具集：
//   1. browser_mcp.manage_dynamic_tool 引导器——唯一的本地内置项；
//   2. 服务器经 device:tool-config 下发的浏览器工具；
//   3. 本地经 manager 创作的动态工具。
// 所有 MCP 由服务器发放，本地不再有复选框控制是否允许调用。
// 服务器托管工具不套用本地描述改写——请在服务器 / Web 控制台修改。

import { AIToolDef } from '../types'
import { getToolDescOverrides } from '../storage'
import { dynamicMcpToolDefs, isServerManagedToolDef } from './dynamic'

export async function allToolDefs(): Promise<AIToolDef[]> {
  // 上报目录 = 动态工具集（manager 引导器 + 服务器下发 + 本地创作），不再合并硬编码
  // BROWSER_TOOLS。首次连接、服务器尚未下发前，这里只有 manager 引导器（与桌面端一致）。
  return await dynamicMcpToolDefs()
}

/** Names of all tools (本地 enable/disable 已移除，所有服务器下发 MCP 默认可用)。 */
export async function enabledToolNames(): Promise<string[]> {
  return (await allToolDefs()).map(t => t.name)
}

export async function effectiveToolDefs(): Promise<AIToolDef[]> {
  const overrides = await getToolDescOverrides()
  return (await allToolDefs()).map(tool => {
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