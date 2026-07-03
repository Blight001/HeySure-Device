// runtime-tool — port of device/shared/src/runtime/runtime-tool.ts: execute a
// server-authored tool whose body is plain source for a device runtime
// (python / powershell / shell). Permission guard first, then the runner.

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
