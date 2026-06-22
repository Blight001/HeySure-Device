// runtime-tool — execute a server-authored tool whose body is plain source for
// a device runtime (python / powershell / shell), rather than the program DSL
// or injected-JS kinds. This is the device half of 设备端MCP代码下放长期方案
// 阶段一: the server owns the code, the device runs it under guard + permissions.
//
// Every call goes through the permission guard first, then the matching runner
// (which is itself wrapped by process-guard for timeout / kill / truncation).

import { runShell } from './shell-runner'
import { runPowerShell } from './powershell-runner'
import { runPython } from './python-runner'
import { checkPermissions, type PermissionTag } from './permission-guard'

export type ToolRuntime = 'python' | 'powershell' | 'shell'

export function isToolRuntime(value: any): value is ToolRuntime {
  return value === 'python' || value === 'powershell' || value === 'shell'
}

export interface RuntimeToolSpec {
  name: string
  runtime: ToolRuntime
  /** The tool body: a python script, a PowerShell script, or a shell command. */
  source: string
  /** Permission tags declared by the tool; checked locally before running. */
  permissions?: string[]
  description?: string
  timeoutMs?: number
}

// Substitute ${args.x} (and dotted paths) into shell / powershell sources.
// Python receives the args dict natively, so it is not templated here.
function renderTemplate(source: string, args: Record<string, any>): string {
  return String(source).replace(/\$\{args\.([a-zA-Z0-9_.]+)\}/g, (_m, expr) => {
    const found = String(expr).split('.').reduce((o: any, k: string) => (o == null ? undefined : o[k]), args)
    return found == null ? '' : typeof found === 'string' ? found : JSON.stringify(found)
  })
}

export async function runRuntimeTool(
  spec: RuntimeToolSpec,
  workspaceRoot: string,
  args: Record<string, any>,
): Promise<any> {
  const permission = await checkPermissions({
    tool: spec.name,
    permissions: (spec.permissions || []) as PermissionTag[],
    summary: spec.description,
  })
  if (!permission.allowed) {
    throw new Error(permission.reason || `权限被拒绝: ${spec.name}`)
  }

  const source = String(spec.source || '')
  switch (spec.runtime) {
    case 'python':
      return runPython({ code: source, args, cwd: workspaceRoot, timeoutMs: spec.timeoutMs })
    case 'powershell':
      return runPowerShell(renderTemplate(source, args), { cwd: workspaceRoot, timeoutMs: spec.timeoutMs })
    case 'shell':
      return runShell(workspaceRoot, {
        command: renderTemplate(source, args),
        cwd: args.cwd,
        shell: args.shell ?? args.shell_type,
        timeoutMs: spec.timeoutMs ?? (Number(args.timeout_ms || args.timeoutMs) || undefined),
      })
    default:
      throw new Error(`Unsupported runtime: ${(spec as any).runtime}`)
  }
}
