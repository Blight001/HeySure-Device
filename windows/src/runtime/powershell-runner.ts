// powershell-runner — the primary runtime driving server-pushed MCP tools on
// Windows (Windows PowerShell 5.1 first, then pwsh).
//
// Contract for the supplied script:
//   - an object ``$toolArgs`` is pre-populated from the call arguments
//     (JSON via the HEYSURE_TOOL_ARGS env var);
//   - assign the tool's output to a variable ``$result`` (any JSON value);
//   - anything else printed is captured as stdout.
// Legacy template-only scripts (no ``$result``) keep working: their stdout is
// returned unchanged and ``result`` stays null.

import { native } from '../native'
import { runProcess, type ProcessRunResult } from './process'
import { POWERSHELL_TIMEOUT_MS } from '../constants'

const RESULT_SENTINEL = '__HEYSURE_RESULT__='

export interface PowerShellRunOptions {
  args?: Record<string, any>
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
  /** Parsed value of the script's ``$result`` variable, when present. */
  result: any
}

// Wrap the tool body with the $toolArgs / $result contract. ConvertFrom-Json
// (no -AsHashtable) keeps the script Windows PowerShell 5.1 compatible.
function buildScript(code: string): string {
  return [
    '$toolArgs = $null',
    'if ($env:HEYSURE_TOOL_ARGS) { try { $toolArgs = ConvertFrom-Json -InputObject $env:HEYSURE_TOOL_ARGS } catch { $toolArgs = $null } }',
    'if ($null -eq $toolArgs) { $toolArgs = New-Object PSObject }',
    '$result = $null',
    '',
    code,
    '',
    `Write-Output ('${RESULT_SENTINEL}' + $(if ($null -eq $result) { 'null' } else { ConvertTo-Json -InputObject $result -Depth 10 -Compress }))`,
  ].join('\n')
}

function splitResult(stdout: string): { stdout: string; result: any } {
  const idx = stdout.lastIndexOf(RESULT_SENTINEL)
  if (idx < 0) return { stdout, result: null }
  const before = stdout.slice(0, idx).replace(/\r?\n$/, '')
  const json = stdout.slice(idx + RESULT_SENTINEL.length).trim()
  try {
    return { stdout: before, result: JSON.parse(json) }
  } catch {
    return { stdout, result: null }
  }
}

export async function runPowerShell(
  script: string,
  options: PowerShellRunOptions = {},
): Promise<PowerShellRunResult> {
  const command = await resolvePowerShell()
  if (!command) {
    return {
      available: false, result: null, exitCode: 127, signal: null, stdout: '',
      stderr: 'PowerShell 不可用（未找到 powershell.exe / pwsh）。',
      timedOut: false, truncated: false, killed: false, durationMs: 0,
    }
  }
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encodePowerShellScript(buildScript(script))]
  const run = await runProcess(command, args, {
    cwd: options.cwd,
    env: { ...options.env, HEYSURE_TOOL_ARGS: JSON.stringify(options.args || {}) },
    timeoutMs: options.timeoutMs ?? POWERSHELL_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes,
  })
  const split = splitResult(run.stdout)
  return { available: true, result: split.result, ...run, stdout: split.stdout }
}
