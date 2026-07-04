export const SHELL_TIMEOUT_MS       = 60_000
export const SHELL_MAX_BUFFER_BYTES  = 4 * 1024 * 1024
export const FS_READ_LIMIT_BYTES     = 200_000
export const SCREENSHOT_TIMEOUT_MS   = 15_000
export const TASK_OUTCOME_CACHE_SIZE = 500

// Controlled-executor base (runtime/*). These bound any server-authored code
// the device runs via the powershell / shell runners.
export const PROCESS_TIMEOUT_MS       = 60_000          // default hard timeout
export const PROCESS_KILL_GRACE_MS    = 2_000           // SIGTERM → SIGKILL grace
export const MAX_CONCURRENT_PROCESSES = 4               // process-guard concurrency cap
export const PROCESS_OUTPUT_MAX_BYTES = 1 * 1024 * 1024 // per-stream stdout/stderr cap
export const POWERSHELL_TIMEOUT_MS    = 120_000         // powershell drives the MCP tools; allow longer runs
export const ARTIFACT_MAX_BYTES       = 16 * 1024 * 1024
