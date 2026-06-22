// process-guard — the one place every server-authored runner spawns a child.
//
// Responsibilities (设备端MCP代码下放长期方案 §3.2 / §7.1):
//   - hard timeout: SIGTERM, then SIGKILL after a grace window;
//   - concurrency limit: at most MAX_CONCURRENT_PROCESSES run at once, the rest
//     queue (so a burst of tool calls can't fork-bomb the device);
//   - output truncation: stdout / stderr are capped so a runaway process can't
//     exhaust memory or flood the activity log;
//   - global pause / abort: one switch stops new runs and kills everything in
//     flight, satisfying "设备端必须能一键暂停远程执行".
//
// Runtime-neutral on purpose: no Electron import, just child_process, so it is
// identical on Windows and Linux and unit-testable in isolation.

import { spawn, type ChildProcess } from 'child_process'
import {
  MAX_CONCURRENT_PROCESSES,
  PROCESS_KILL_GRACE_MS,
  PROCESS_OUTPUT_MAX_BYTES,
  PROCESS_TIMEOUT_MS,
} from '../constants'

export interface ProcessRunOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  /** Written to the child's stdin then closed. */
  input?: string
  /** Hard timeout in ms; <= 0 disables the timer. Defaults to PROCESS_TIMEOUT_MS. */
  timeoutMs?: number
  /** Per-stream byte cap before truncation. Defaults to PROCESS_OUTPUT_MAX_BYTES. */
  maxOutputBytes?: number
  /** Passed through to child_process.spawn (string shell or true). */
  shell?: boolean | string
  /** Hide the console window on Windows. */
  windowsHide?: boolean
}

export interface ProcessRunResult {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  /** Killed because it exceeded timeoutMs. */
  timedOut: boolean
  /** Output hit maxOutputBytes and was cut. */
  truncated: boolean
  /** Killed by the guard (timeout, pause, or killAllProcesses). */
  killed: boolean
  durationMs: number
}

let paused = false
let runningCount = 0
const waiters: Array<() => void> = []
const active = new Map<number, ChildProcess>()
let nextId = 1

export class ExecutionPausedError extends Error {
  constructor(message = '设备已暂停远程执行') {
    super(message)
    this.name = 'ExecutionPausedError'
  }
}

/** Stop accepting new runs and kill everything in flight. */
export function pauseExecution(reason = 'paused'): number {
  paused = true
  return killAllProcesses(reason)
}

export function resumeExecution(): void {
  paused = false
}

export function isExecutionPaused(): boolean {
  return paused
}

export function activeProcessCount(): number {
  return active.size
}

/** Best-effort terminate every tracked child. Returns how many were signalled. */
export function killAllProcesses(_reason = 'killed'): number {
  const children = Array.from(active.values())
  for (const child of children) terminate(child)
  return children.length
}

function terminate(child: ChildProcess): void {
  try {
    child.kill('SIGTERM')
  } catch { /* already gone */ }
  setTimeout(() => {
    try {
      if (!child.killed) child.kill('SIGKILL')
    } catch { /* already gone */ }
  }, PROCESS_KILL_GRACE_MS)
}

function acquireSlot(): Promise<void> {
  if (runningCount < MAX_CONCURRENT_PROCESSES) {
    runningCount += 1
    return Promise.resolve()
  }
  return new Promise(resolve => waiters.push(resolve))
}

function releaseSlot(): void {
  runningCount = Math.max(0, runningCount - 1)
  const next = waiters.shift()
  if (next) {
    runningCount += 1
    next()
  }
}

/**
 * Spawn ``command`` with ``args`` under the guard. Never rejects on a non-zero
 * exit or a missing binary — those surface via exitCode / stderr — so callers
 * always get a structured result. Rejects only when execution is paused.
 */
export async function runProcess(
  command: string,
  args: string[] = [],
  options: ProcessRunOptions = {},
): Promise<ProcessRunResult> {
  if (paused) throw new ExecutionPausedError()

  const timeoutMs = options.timeoutMs ?? PROCESS_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? PROCESS_OUTPUT_MAX_BYTES

  await acquireSlot()
  const id = nextId++
  const startedAt = Date.now()

  try {
    return await new Promise<ProcessRunResult>(resolve => {
      let child: ChildProcess
      try {
        child = spawn(command, args, {
          cwd: options.cwd,
          env: options.env as any,
          shell: options.shell,
          windowsHide: options.windowsHide ?? true,
        })
      } catch (err: any) {
        resolve({
          exitCode: 127, signal: null, stdout: '', stderr: err?.message || String(err),
          timedOut: false, truncated: false, killed: false, durationMs: Date.now() - startedAt,
        })
        return
      }

      active.set(id, child)

      let stdout = ''
      let stderr = ''
      let outBytes = 0
      let errBytes = 0
      let truncated = false
      let timedOut = false
      let killedByGuard = false

      const cap = (current: string, addition: string, bytes: number): [string, number] => {
        if (bytes >= maxOutputBytes) { truncated = true; return [current, bytes] }
        const room = maxOutputBytes - bytes
        const slice = addition.length > room ? addition.slice(0, room) : addition
        if (slice.length < addition.length) truncated = true
        return [current + slice, bytes + slice.length]
      }

      child.stdout?.on('data', (chunk: any) => {
        ;[stdout, outBytes] = cap(stdout, chunk.toString(), outBytes)
      })
      child.stderr?.on('data', (chunk: any) => {
        ;[stderr, errBytes] = cap(stderr, chunk.toString(), errBytes)
      })

      const timer = timeoutMs > 0
        ? setTimeout(() => { timedOut = true; killedByGuard = true; terminate(child) }, timeoutMs)
        : null

      if (options.input != null) {
        try { child.stdin?.end(options.input) } catch { /* stdin may be closed */ }
      }

      child.on('error', (err: any) => {
        if (timer) clearTimeout(timer)
        active.delete(id)
        resolve({
          exitCode: 127, signal: null, stdout: stdout.trim(),
          stderr: (stderr + (stderr ? '\n' : '') + (err?.message || String(err))).trim(),
          timedOut, truncated, killed: killedByGuard, durationMs: Date.now() - startedAt,
        })
      })

      child.on('close', (code: number | null, signal: string | null) => {
        if (timer) clearTimeout(timer)
        active.delete(id)
        resolve({
          exitCode: typeof code === 'number' ? code : null,
          signal: signal ?? null,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          timedOut,
          truncated,
          killed: killedByGuard,
          durationMs: Date.now() - startedAt,
        })
      })
    })
  } finally {
    releaseSlot()
  }
}
