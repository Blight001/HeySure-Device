// runtime-probe: reports at register time which runtimes this device can execute.
// Only powershell and shell are supported on Windows after Python removal.

import { runProcess } from './process'
import { resolvePowerShell } from './powershell-runner'

export interface RuntimeInfo {
  available: boolean
  version: string
}

export interface RuntimeReport {
  powershell: RuntimeInfo
  shell: RuntimeInfo
}

let cached: RuntimeReport | null = null

async function probeCommand(command: string | null, args: string[]): Promise<RuntimeInfo> {
  if (!command) return { available: false, version: '' }
  try {
    const result = await runProcess(command, args, { timeoutMs: 5000 })
    const text = `${result.stdout} ${result.stderr}`.trim()
    return { available: result.exitCode === 0, version: text.split('\n')[0].slice(0, 80) }
  } catch {
    return { available: false, version: '' }
  }
}

/** Probe (and cache) the runtimes this device can execute. */
export async function probeRuntimes(force = false): Promise<RuntimeReport> {
  if (cached && !force) return cached
  const powershell = await resolvePowerShell().then(cmd =>
    probeCommand(cmd, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']))
  // cmd always exists on Windows; shell tools are always runnable.
  const shell: RuntimeInfo = { available: true, version: 'cmd' }
  cached = { powershell, shell }
  return cached
}

/** Last probe result, or null if probeRuntimes() hasn't completed yet. */
export function cachedRuntimes(): RuntimeReport | null {
  return cached
}
