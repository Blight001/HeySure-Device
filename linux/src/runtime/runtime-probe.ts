// runtime-probe — detect which device runtimes can actually execute, so the
// device can report them at register time (设备端MCP代码下放长期方案 阶段三:
// "设备注册时只上报运行能力"). The server uses this to know whether a runtime
// tool (python/powershell/shell) has any device that can run it.
//
// Availability is verified by actually spawning the interpreter (a bare PATH
// name resolves optimistically, so only a real spawn proves it exists).

import { runProcess } from './process-guard'
import { resolvePython } from './python-runner'
import { resolvePowerShell } from './powershell-runner'

export interface RuntimeInfo {
  available: boolean
  version: string
}

export interface RuntimeReport {
  python: RuntimeInfo
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
  const [python, powershell] = await Promise.all([
    probeCommand(resolvePython(), ['--version']),
    probeCommand(resolvePowerShell(), ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']),
  ])
  // cmd / bash always exist on their platform; shell tools are always runnable.
  const shell: RuntimeInfo = { available: true, version: process.platform === 'win32' ? 'cmd' : 'bash' }
  cached = { python, powershell, shell }
  return cached
}

/** Last probe result, or null if probeRuntimes() hasn't completed yet. */
export function cachedRuntimes(): RuntimeReport | null {
  return cached
}
