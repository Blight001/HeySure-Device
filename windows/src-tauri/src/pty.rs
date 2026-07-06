// 命令行远程（PTY）—— Windows ConPTY 会话管理，为「统一远程连接」的 rt:* 通道
// 提供真正的交互式终端底座（对应 device/read.md「命令行远程」）。
//
// 与画面远程（rc.rs：原生抓屏 + enigo 键鼠注入，走 WebRTC P2P）是两条独立数据面：
// 终端是低带宽字节流，直接经 Socket.IO relay 转发（无需 TURN），故这里只负责
// 「本机 shell ⇄ 字节流」：
//   - pty_open   起一个 ConPTY 会话，spawn shell，后台 reader 线程把 PTY 输出
//                base64 后通过 Tauri 事件 `pty://data` 推给 WebView，退出时推 `pty://exit`；
//   - pty_write  把控制端键入（base64）解码后写进 PTY；
//   - pty_resize 调整 PTY 行列；
//   - pty_close  杀掉子进程并回收会话。
//
// WebView 侧（src/remote-terminal.ts）把这些事件桥接到服务器 rt:data/rt:exit，
// 并把服务器 rt:input/rt:resize/rt:close 翻译成这里的命令。会话按 sessionId 隔离，
// 可同时存在多个终端。

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

/// 一个活动的 PTY 会话。reader 线程与子进程 wait 都发生在后台线程里，主表只保留
/// 写入 / 调整大小 / 结束所需的句柄。
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

fn sessions() -> &'static Mutex<HashMap<String, PtySession>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, PtySession>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PtyDataEvent {
    session_id: String,
    /// base64 of the raw PTY output bytes (control sequences survive intact).
    data: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PtyExitEvent {
    session_id: String,
    code: Option<u32>,
}

/// Map a requested shell name to a Windows executable. Empty / unknown / "auto"
/// falls back to PowerShell — the default interactive shell the desktop ships.
fn resolve_shell(shell: &str) -> &'static str {
    match shell.trim().to_ascii_lowercase().as_str() {
        "cmd" => "cmd.exe",
        "pwsh" => "pwsh.exe",
        "powershell" | "ps" => "powershell.exe",
        _ => "powershell.exe",
    }
}

fn clamp_size(cols: Option<u16>, rows: Option<u16>) -> PtySize {
    PtySize {
        rows: rows.filter(|&r| r > 0).unwrap_or(24),
        cols: cols.filter(|&c| c > 0).unwrap_or(80),
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Open a PTY session, spawn the shell, and start streaming its output as
/// `pty://data` events (ending with `pty://exit`). Errors before the child is
/// spawned surface synchronously so the WebView can emit rt:error.
pub fn open(
    app: AppHandle,
    session_id: String,
    shell: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    cwd: Option<String>,
) -> Result<(), String> {
    let session_id = session_id.trim().to_string();
    if session_id.is_empty() {
        return Err("sessionId is required".into());
    }
    // A repeated open for a live id replaces it (single terminal per session id).
    close(&session_id);

    let size = clamp_size(cols, rows);
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new(resolve_shell(shell.as_deref().unwrap_or("")));
    if let Some(dir) = cwd.as_deref() {
        let dir = dir.trim();
        if !dir.is_empty() && std::path::Path::new(dir).is_dir() {
            cmd.cwd(dir);
        }
    }

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("pty reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("pty writer failed: {e}"))?;
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn shell failed: {e}"))?;
    let killer = child.clone_killer();
    // Drop the slave now so the master read side sees EOF once the child exits.
    drop(pair.slave);

    sessions().lock().unwrap().insert(
        session_id.clone(),
        PtySession { master: pair.master, writer, killer },
    );

    // Reader thread: pump PTY output → base64 → `pty://data`; on EOF reap the
    // child, emit `pty://exit`, and forget the session.
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        use std::io::Read;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let _ = app.emit(
                        "pty://data",
                        PtyDataEvent { session_id: session_id.clone(), data: B64.encode(&buf[..n]) },
                    );
                }
                Err(_) => break,
            }
        }
        let code = child.wait().ok().map(|status| status.exit_code());
        let _ = app.emit("pty://exit", PtyExitEvent { session_id: session_id.clone(), code });
        sessions().lock().unwrap().remove(&session_id);
    });

    Ok(())
}

/// Write operator keystrokes (base64 of raw bytes) into the PTY.
pub fn write(session_id: &str, data_b64: &str) -> Result<(), String> {
    let bytes = B64.decode(data_b64.as_bytes()).map_err(|e| format!("bad base64: {e}"))?;
    let mut guard = sessions().lock().unwrap();
    let session = guard.get_mut(session_id).ok_or("no such session")?;
    session.writer.write_all(&bytes).map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

/// Resize the PTY window (so full-screen TUI apps reflow correctly).
pub fn resize(session_id: &str, cols: Option<u16>, rows: Option<u16>) -> Result<(), String> {
    let guard = sessions().lock().unwrap();
    let session = guard.get(session_id).ok_or("no such session")?;
    session.master.resize(clamp_size(cols, rows)).map_err(|e| e.to_string())
}

/// Kill the shell and forget the session. Safe to call for an unknown id.
pub fn close(session_id: &str) {
    if let Some(mut session) = sessions().lock().unwrap().remove(session_id) {
        let _ = session.killer.kill();
    }
}
