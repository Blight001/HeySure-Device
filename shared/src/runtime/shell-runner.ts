// shell-runner — run a shell command line under the process guard.
//
// Picks the interpreter from the host OS and an optional ``shell`` hint:
//   - Windows: cmd (default), powershell, pwsh
//   - other:   /bin/bash if present, else the platform default shell
//
// Replaces the per-shell exec() in tools/shell.ts so timeout / kill /
// concurrency / truncation all come from one place (process-guard).

import { existsSync } from 'fs'
import * as path from 'path'
import { runProcess } from './process-guard'
import { encodePowerShellScript } from './powershell-runner'
import { SHELL_TIMEOUT_MS } from '../constants'

export type ShellKind = 'auto' | 'cmd' | 'powershell' | 'pwsh' | 'bash'

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

function resolveCwd(workspaceRoot: string, raw?: any): string {
  if (!raw) return workspaceRoot
  const text = String(raw).trim()
  if (!text || text === '.') return workspaceRoot
  return path.isAbsolute(text) ? path.resolve(text) : path.resolve(workspaceRoot, text)
}

interface Spawnable { command: string; args: string[]; label: string }

function buildInvocation(command: string, shellHint: string): Spawnable {
  const hint = shellHint.trim().toLowerCase()
  if (process.platform === 'win32') {
    if (hint === 'powershell' || hint === 'ps') {
      return { command: 'powershell.exe', args: psArgs(command), label: 'powershell' }
    }
    if (hint === 'pwsh') {
      return { command: 'pwsh.exe', args: psArgs(command), label: 'pwsh' }
    }
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', command], label: 'cmd' }
  }
  const bash = existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'
  return { command: bash, args: ['-lc', command], label: path.basename(bash) }
}

function psArgs(command: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encodePowerShellScript(command)]
}

export async function runShell(workspaceRoot: string, options: ShellRunOptions): Promise<ShellRunResult> {
  const command = String(options.command || '')
  if (!command) throw new Error('command is required')

  const cwd = resolveCwd(workspaceRoot, options.cwd)
  if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`)

  const invocation = buildInvocation(command, String(options.shell || ''))
  const result = await runProcess(invocation.command, invocation.args, {
    cwd,
    timeoutMs: options.timeoutMs ?? SHELL_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes,
    windowsHide: true,
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
