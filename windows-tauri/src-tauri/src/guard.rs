// process guard — the one place every server-authored runner spawns a child.
// Rust port of device/shared/src/runtime/process-guard.ts with the same
// semantics: hard timeout, concurrency cap, per-stream output truncation and
// a global pause/kill-all switch ("设备端必须能一键暂停远程执行").
//
// Differences from the Electron/Node version:
//   - kill is TerminateProcess (no SIGTERM grace window on Windows);
//   - spawn failures resolve as exitCode 127 results, never rejections,
//     matching the TS contract so the frontend runners port unchanged.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Semaphore;

pub const MAX_CONCURRENT_PROCESSES: usize = 4;
pub const PROCESS_TIMEOUT_MS: i64 = 60_000;
pub const PROCESS_OUTPUT_MAX_BYTES: usize = 1024 * 1024;

pub const EXECUTION_PAUSED_MARKER: &str = "EXECUTION_PAUSED";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSpec {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub input: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<i64>,
    #[serde(default)]
    pub max_output_bytes: Option<usize>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub truncated: bool,
    pub killed: bool,
    pub duration_ms: u64,
}

struct ProcEntry {
    child: Mutex<tokio::process::Child>,
    killed_by_guard: AtomicBool,
}

static PAUSED: AtomicBool = AtomicBool::new(false);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn semaphore() -> &'static Semaphore {
    static SEM: OnceLock<Semaphore> = OnceLock::new();
    SEM.get_or_init(|| Semaphore::new(MAX_CONCURRENT_PROCESSES))
}

fn active() -> &'static Mutex<HashMap<u64, Arc<ProcEntry>>> {
    static ACTIVE: OnceLock<Mutex<HashMap<u64, Arc<ProcEntry>>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn pause_execution() -> usize {
    PAUSED.store(true, Ordering::SeqCst);
    kill_all_processes()
}

pub fn resume_execution() {
    PAUSED.store(false, Ordering::SeqCst);
}

pub fn is_paused() -> bool {
    PAUSED.load(Ordering::SeqCst)
}

pub fn active_count() -> usize {
    active().lock().map(|m| m.len()).unwrap_or(0)
}

pub fn kill_all_processes() -> usize {
    let entries: Vec<Arc<ProcEntry>> = active()
        .lock()
        .map(|m| m.values().cloned().collect())
        .unwrap_or_default();
    for entry in &entries {
        entry.killed_by_guard.store(true, Ordering::SeqCst);
        if let Ok(mut child) = entry.child.lock() {
            let _ = child.start_kill();
        }
    }
    entries.len()
}

async fn drain<R: tokio::io::AsyncRead + Unpin>(reader: Option<R>, cap: usize) -> (String, bool) {
    let Some(mut reader) = reader else {
        return (String::new(), false);
    };
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut truncated = false;
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if buf.len() < cap {
                    let take = n.min(cap - buf.len());
                    buf.extend_from_slice(&chunk[..take]);
                    if take < n {
                        truncated = true;
                    }
                } else {
                    // Keep draining to EOF so a chatty child never blocks on a
                    // full pipe, but discard everything past the cap.
                    truncated = true;
                }
            }
        }
    }
    (String::from_utf8_lossy(&buf).into_owned(), truncated)
}

pub async fn run_process(spec: RunSpec) -> Result<RunResult, String> {
    if is_paused() {
        return Err(format!("{EXECUTION_PAUSED_MARKER}: 设备已暂停远程执行"));
    }

    let timeout_ms = spec.timeout_ms.unwrap_or(PROCESS_TIMEOUT_MS);
    let cap = spec.max_output_bytes.unwrap_or(PROCESS_OUTPUT_MAX_BYTES);

    let _permit = semaphore().acquire().await.map_err(|e| e.to_string())?;
    // Pause may have flipped while this call sat in the queue.
    if is_paused() {
        return Err(format!("{EXECUTION_PAUSED_MARKER}: 设备已暂停远程执行"));
    }

    let started = Instant::now();

    let mut cmd = tokio::process::Command::new(&spec.command);
    cmd.args(&spec.args);
    if let Some(cwd) = spec.cwd.as_deref() {
        if !cwd.trim().is_empty() {
            cmd.current_dir(cwd);
        }
    }
    cmd.envs(&spec.env);
    cmd.stdin(if spec.input.is_some() { Stdio::piped() } else { Stdio::null() });
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            // Missing binary / bad cwd surface as a structured result, matching
            // the TS guard (callers always get exitCode/stderr, never a throw).
            return Ok(RunResult {
                exit_code: Some(127),
                stderr: err.to_string(),
                duration_ms: started.elapsed().as_millis() as u64,
                ..Default::default()
            });
        }
    };

    if let Some(input) = spec.input {
        if let Some(mut stdin) = child.stdin.take() {
            tokio::spawn(async move {
                let _ = stdin.write_all(input.as_bytes()).await;
                let _ = stdin.shutdown().await;
            });
        }
    }

    let out_task = tokio::spawn(drain(child.stdout.take(), cap));
    let err_task = tokio::spawn(drain(child.stderr.take(), cap));

    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let entry = Arc::new(ProcEntry {
        child: Mutex::new(child),
        killed_by_guard: AtomicBool::new(false),
    });
    if let Ok(mut map) = active().lock() {
        map.insert(id, entry.clone());
    }

    let deadline = if timeout_ms > 0 {
        Some(started + Duration::from_millis(timeout_ms as u64))
    } else {
        None
    };

    let mut timed_out = false;
    let wait_outcome = loop {
        let polled = match entry.child.lock() {
            Ok(mut child) => child.try_wait().map_err(|err| err.to_string()),
            Err(_) => Err("process guard poisoned".to_string()),
        };
        match polled {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => {}
            Err(err) => break Err(err),
        }
        if let Some(deadline) = deadline {
            if !timed_out && Instant::now() >= deadline {
                timed_out = true;
                entry.killed_by_guard.store(true, Ordering::SeqCst);
                if let Ok(mut child) = entry.child.lock() {
                    let _ = child.start_kill();
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    };

    if let Ok(mut map) = active().lock() {
        map.remove(&id);
    }

    let (stdout, out_truncated) = out_task.await.unwrap_or_default();
    let (stderr, err_truncated) = err_task.await.unwrap_or_default();
    let killed = entry.killed_by_guard.load(Ordering::SeqCst);
    let duration_ms = started.elapsed().as_millis() as u64;

    match wait_outcome {
        Ok(status) => Ok(RunResult {
            exit_code: status.code(),
            signal: None,
            stdout: stdout.trim().to_string(),
            stderr: stderr.trim().to_string(),
            timed_out,
            truncated: out_truncated || err_truncated,
            killed,
            duration_ms,
        }),
        Err(err) => Ok(RunResult {
            exit_code: Some(127),
            stdout: stdout.trim().to_string(),
            stderr: if stderr.trim().is_empty() {
                err
            } else {
                format!("{}\n{}", stderr.trim(), err)
            },
            timed_out,
            truncated: out_truncated || err_truncated,
            killed,
            duration_ms,
            ..Default::default()
        }),
    }
}
