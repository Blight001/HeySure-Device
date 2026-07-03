// shell-runner — port of device/shared/src/runtime/shell-runner.ts (Windows
// half; this prototype is the Windows shell, so the bash branch is dropped).
//   - cmd (default), powershell, pwsh

import { native } from '../native'
import { runProcess } from './process'
import { encodePowerShellScript } from './powershell-runner'
import { SHELL_TIMEOUT_MS } from '../constants'

export type ShellKind = 'auto' | 'cmd' | 'powershell' | 'pwsh'

export interface ShellRunOptions {
  command: string
  /** Relative to workspaceRoot, or absolute. Defaults to workspaceRoot. */
  cwd?: string
  shell?: ShellKind | string
  timeoutMs?: number
  maxOutputBytes?: number
}

export interface ShellRunResult {
  command: string
  cwd: string
  shell: string
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
  killed: boolean
  durationMs: number
}

function isAbsolute(text: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('\\\\')
}

function joinPath(base: string, relative: string): string {
  const sep = base.includes('/') && !base.includes('\\') ? '/' : '\\'
  return `${base.replace(/[\\/]+$/, '')}${sep}${relative.replace(/^[\\/]+/, '')}`
}

function resolveCwd(workspaceRoot: string, raw?: any): string {
  if (!raw) return workspaceRoot
  const text = String(raw).trim()
  if (!text || text === '.') return workspaceRoot
  return isAbsolute(text) ? text : joinPath(workspaceRoot, text)
}

interface Spawnable { command: string; args: string[]; label: string }

function psArgs(command: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encodePowerShellScript(command)]
}

function buildInvocation(command: string, shellHint: string): Spawnable {
  const hint = shellHint.trim().toLowerCase()
  if (hint === 'powershell' || hint === 'ps') {
    return { command: 'powershell.exe', args: psArgs(command), label: 'powershell' }
  }
  if (hint === 'pwsh') {
    return { command: 'pwsh.exe', args: psArgs(command), label: 'pwsh' }
  }
  return { command: 'cmd.exe', args: ['/d', '/s', '/c', command], label: 'cmd' }
}

export async function runShell(workspaceRoot: string, options: ShellRunOptions): Promise<ShellRunResult> {
  const command = String(options.command || '')
  if (!command) throw new Error('command is required')

  const cwd = resolveCwd(workspaceRoot, options.cwd)
  if (!(await native.fileExists(cwd))) throw new Error(`cwd does not exist: ${cwd}`)

  const invocation = buildInvocation(command, String(options.shell || ''))
  const result = await runProcess(invocation.command, invocation.args, {
    cwd,
    timeoutMs: options.timeoutMs ?? SHELL_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes,
  })

  return {
    command,
    cwd,
    shell: invocation.label,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    truncated: result.truncated,
    killed: result.killed,
    durationMs: result.durationMs,
  }
}
