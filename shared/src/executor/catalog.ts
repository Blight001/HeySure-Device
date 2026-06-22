// The device is a controlled runner with a single native built-in: the
// dynamic-tool manager (mcp.manage_dynamic_tool). It is the bootstrap that
// loads server-pushed tools and therefore cannot itself be dynamic.
//
// EVERYTHING else — keyboard / mouse / screen / window / … and even shell.run —
// is a server-pushed runtime tool (python / powershell / shell) executed by the
// runtime base. See 设备端MCP代码下放长期方案 阶段三/四.

import { registerTools } from './registry'
import { DYNAMIC_MCP_MANAGER_DEFINITION } from './dynamic'

registerTools([DYNAMIC_MCP_MANAGER_DEFINITION])
