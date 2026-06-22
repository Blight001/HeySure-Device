// powershell-runner — run a PowerShell script under the process guard.
//
// Windows resolves Windows PowerShell (powershell.exe) first, then PowerShell 7
// (pwsh). Non-Windows hosts only have PowerShell 7 if it was installed, so the
// runner reports it as unavailable cleanly instead of throwing ENOENT.
//
// Self-contained on purpose (no dependency on the Windows-only
// tools/shared/powershell.ts) so it can live in device/shared and be synced to
// both shells.

import { existsSync } from 'fs'
import { runProcess, type ProcessRunResult } from './process-guard'

export interface PowerShellRunOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  timeoutMs?: number
  maxOutputBytes?: number
}

/** Base64 (UTF-16LE) encoding for -EncodedCommand, with a UTF-8 output prelude. */
export function encodePowerShellScript(script: string): string {
  const prelude = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
  ].join('\n')
  return Buffer.from(`${prelude}\n${script}`, 'utf16le').toString('base64')
}

function candidates(): string[] {
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot || 'C:\\Windows'
    return [
      `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      `${root}\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe`,
      'powershell.exe',
      'pwsh.exe',
    ]
  }
  return ['pwsh']
}

/** Absolute path / bare command of the best available PowerShell, or null. */
export function resolvePowerShell(): string | null {
  for (const cmd of candidates()) {
    if (cmd.includes('\\') || cmd.includes('/')) {
      if (existsSync(cmd)) return cmd
    } else {
      // Bare command (powershell.exe / pwsh): assume on PATH; spawn will report
      // ENOENT through the result if it is not actually present.
      return cmd
    }
  }
  return null
}

export function isPowerShellAvailable(): boolean {
  return resolvePowerShell() != null
}

export interface PowerShellRunResult extends ProcessRunResult {
  available: boolean
}

export async function runPowerShell(
  script: string,
  options: PowerShellRunOptions = {},
): Promise<PowerShellRunResult> {
  const command = resolvePowerShell()
  if (!command) {
    return {
      available: false, exitCode: 127, signal: null, stdout: '',
      stderr: 'PowerShell 不可用（未找到 powershell.exe / pwsh）。',
      timedOut: false, truncated: false, killed: false, durationMs: 0,
    }
  }
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encodePowerShellScript(script)]
  const result = await runProcess(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
    windowsHide: true,
  })
  return { available: true, ...result }
}
