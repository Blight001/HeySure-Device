// powershell-runner — port of device/shared/src/runtime/powershell-runner.ts.
// Windows resolves Windows PowerShell (powershell.exe) first, then pwsh.

import { native } from '../native'
import { runProcess, type ProcessRunResult } from './process'

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
  const full = `${prelude}\n${script}`
  // JS strings are UTF-16 code units; emit them little-endian byte by byte.
  const bytes = new Uint8Array(full.length * 2)
  for (let i = 0; i < full.length; i++) {
    const code = full.charCodeAt(i)
    bytes[2 * i] = code & 0xff
    bytes[2 * i + 1] = code >> 8
  }
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

let cachedPowerShell: string | null | undefined

/** Absolute path / bare command of the best available PowerShell, or null. */
export async function resolvePowerShell(): Promise<string | null> {
  if (cachedPowerShell !== undefined) return cachedPowerShell
  const system32 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  if (await native.fileExists(system32)) {
    cachedPowerShell = system32
    return cachedPowerShell
  }
  // Bare command: assume on PATH; spawn surfaces a clear error if not present.
  cachedPowerShell = (await native.whichCommand('powershell')) || (await native.whichCommand('pwsh')) || 'powershell.exe'
  return cachedPowerShell
}

export interface PowerShellRunResult extends ProcessRunResult {
  available: boolean
}

export async function runPowerShell(
  script: string,
  options: PowerShellRunOptions = {},
): Promise<PowerShellRunResult> {
  const command = await resolvePowerShell()
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
  })
  return { available: true, ...result }
}
