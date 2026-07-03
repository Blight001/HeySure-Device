// process — frontend face of the Rust process guard (src-tauri/src/guard.rs).
// Timeout / concurrency / truncation / pause all live in Rust; this module
// keeps the TS call shape identical to the Electron runtime's process-guard so
// the runners port unchanged.

import { native, type ProcessRunResult } from '../native'

export type { ProcessRunResult }

export interface ProcessRunOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  input?: string
  timeoutMs?: number
  maxOutputBytes?: number
}

export class ExecutionPausedError extends Error {
  constructor(message = '设备已暂停远程执行') {
    super(message)
    this.name = 'ExecutionPausedError'
  }
}

function cleanEnv(env?: Record<string, string | undefined>): Record<string, string> | undefined {
  if (!env) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value != null) out[key] = String(value)
  }
  return out
}

export async function runProcess(
  command: string,
  args: string[] = [],
  options: ProcessRunOptions = {},
): Promise<ProcessRunResult> {
  try {
    return await native.runProcess({
      command,
      args,
      cwd: options.cwd,
      env: cleanEnv(options.env),
      input: options.input,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    })
  } catch (err: any) {
    const message = typeof err === 'string' ? err : err?.message || String(err)
    if (message.includes('EXECUTION_PAUSED')) throw new ExecutionPausedError()
    throw new Error(message)
  }
}

export const pauseExecution = (): Promise<number> => native.pauseExecution()
export const resumeExecution = (): Promise<void> => native.resumeExecution()
export const killAllProcesses = (): Promise<number> => native.killAllProcesses()
export const executionState = (): Promise<{ paused: boolean; active: number }> => native.executionState()
