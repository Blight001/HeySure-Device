// runtime-tool: execute a server-authored runtime tool (powershell or shell).
// Permission guard first, then the runner.

import { runShell } from './shell-runner'
import { runPowerShell } from './powershell-runner'
import { checkPermissions, type PermissionTag } from './permission-guard'

export type ToolRuntime = 'powershell' | 'shell'

export function isToolRuntime(value: any): value is ToolRuntime {
  return value === 'powershell' || value === 'shell'
}

export interface RuntimeToolSpec {
  name: string
  runtime: ToolRuntime
  /** The tool body: a PowerShell script or a shell command. */
  source: string
  permissions?: string[]
  description?: string
  timeoutMs?: number
}

// Substitute ${args.x} (and dotted paths) into shell / powershell sources.
// PowerShell also receives the args natively via $toolArgs object;
// templating is kept for legacy shell-style sources.
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
    case 'powershell':
      return runPowerShell(renderTemplate(source, args), { args, cwd: workspaceRoot, timeoutMs: spec.timeoutMs })
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
