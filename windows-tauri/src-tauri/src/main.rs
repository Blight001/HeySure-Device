// HeySure Device — Tauri 2 桌面壳（第一阶段原型）。
//
// Rust 只承接原 Electron main process 的原生职责：受守护的子进程执行、
// 设置/动态工具持久化、托盘与窗口控制。设备协议（Socket.IO 注册、动态
// MCP、任务分发）全部保留在前端 TypeScript（src/）中，见迁移报告
// doc/tauri2-migration-report.md「保留现有协议与业务逻辑」。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod guard;
mod rc;

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

#[tauri::command]
async fn run_process(spec: guard::RunSpec) -> Result<guard::RunResult, String> {
    guard::run_process(spec).await
}

#[tauri::command]
fn pause_execution() -> usize {
    guard::pause_execution()
}

#[tauri::command]
fn resume_execution() {
    guard::resume_execution()
}

#[tauri::command]
fn kill_all_processes() -> usize {
    guard::kill_all_processes()
}

#[tauri::command]
fn execution_state() -> Value {
    json!({ "paused": guard::is_paused(), "active": guard::active_count() })
}

#[tauri::command]
fn host_info() -> Value {
    let hostname = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".to_string());
    let home_dir = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    json!({
        "hostname": hostname,
        "platform": if cfg!(windows) { "win32" } else { std::env::consts::OS },
        "arch": std::env::consts::ARCH,
        "cpus": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        "homeDir": home_dir,
        "heysurePython": std::env::var("HEYSURE_PYTHON").ok(),
    })
}

#[tauri::command]
fn app_paths(app: AppHandle) -> Value {
    let resource_dir = app
        .path()
        .resource_dir()
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_string_lossy().into_owned()));
    let current_dir = std::env::current_dir()
        .ok()
        .map(|p| p.to_string_lossy().into_owned());

    json!({
        "resourceDir": resource_dir,
        "exeDir": exe_dir,
        "currentDir": current_dir,
    })
}

#[tauri::command]
fn which_command(name: String) -> Option<String> {
    let name = name.trim();
    if name.is_empty() || name.contains('/') || name.contains('\\') {
        return None;
    }
    let paths = std::env::var_os("PATH")?;
    let has_ext = name.rsplit('.').next().map(|e| e.len() <= 4 && e != name).unwrap_or(false);
    let exts: &[&str] = if has_ext { &[""] } else { &[".exe", ".cmd", ".bat", ""] };
    for dir in std::env::split_paths(&paths) {
        for ext in exts {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

#[tauri::command]
fn file_exists(path: String) -> bool {
    !path.trim().is_empty() && std::path::Path::new(&path).exists()
}

#[tauri::command]
fn ensure_dir(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("path is empty".to_string());
    }
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

fn config_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("invalid config file name".to_string());
    }
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

#[tauri::command]
fn config_paths(app: AppHandle) -> Result<Value, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(json!({ "configDir": dir.to_string_lossy() }))
}

#[tauri::command]
fn load_json_file(app: AppHandle, name: String) -> Result<Value, String> {
    let path = config_file(&app, &name)?;
    if !path.exists() {
        return Ok(Value::Null);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_json_file(app: AppHandle, name: String, value: Value) -> Result<(), String> {
    let path = config_file(&app, &name)?;
    let temp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    std::fs::write(&temp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &path).map_err(|e| e.to_string())
}

static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);
const TEMP_PREFIX: &str = "heysure-tauri-";

#[tauri::command]
fn write_temp_script(contents: String, filename: String) -> Result<Value, String> {
    if filename.is_empty() || filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err("invalid script file name".to_string());
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = TEMP_SEQ.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("{TEMP_PREFIX}{nanos}-{seq}"));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&filename);
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(json!({
        "dir": dir.to_string_lossy(),
        "path": path.to_string_lossy(),
    }))
}

#[tauri::command]
fn remove_temp_dir(dir: String) -> bool {
    let path = PathBuf::from(&dir);
    // Only directories we created (under the OS temp dir, with our prefix) may
    // be removed through this command.
    let inside_temp = path.starts_with(std::env::temp_dir());
    let ours = path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with(TEMP_PREFIX))
        .unwrap_or(false);
    if !inside_temp || !ours {
        return false;
    }
    std::fs::remove_dir_all(&path).is_ok()
}

fn tray_icon_bytes(status: &str) -> &'static [u8] {
    // Include from local per-platform assets/ (decoupled from device/shared)
    match status {
        "connecting" | "connected" => include_bytes!("../../assets/desktop_yellow.png"),
        "registered" => include_bytes!("../../assets/desktop_green.png"),
        "error" => include_bytes!("../../assets/desktop_red.png"),
        _ => include_bytes!("../../assets/desktop.png"),
    }
}

fn status_label(status: &str) -> &'static str {
    match status {
        "connecting" => "连接中...",
        "connected" => "已连接",
        "registered" => "已注册",
        "error" => "连接错误",
        _ => "未连接",
    }
}

fn is_status_active(status: &str) -> bool {
    matches!(status, "connected" | "registered")
}

fn build_tray_menu<R: Runtime>(
    app: &AppHandle<R>,
    status: &str,
    paused: bool,
) -> tauri::Result<Menu<R>> {
    let status_text = format!("状态: {}", status_label(status));
    let status_item = MenuItem::with_id(app, "status", status_text, false, None::<&str>)?;

    let sep1 = PredefinedMenuItem::separator(app)?;

    let connect_label = if is_status_active(status) { "断开连接" } else { "连接服务器" };
    let connect_item = MenuItem::with_id(app, "toggle-connect", connect_label, true, None::<&str>)?;

    let pause_label = if paused { "恢复远程执行" } else { "暂停远程执行" };
    let pause_item = MenuItem::with_id(app, "toggle-pause", pause_label, true, None::<&str>)?;

    let panel_item = MenuItem::with_id(app, "open-panel", "打开面板", true, None::<&str>)?;

    let sep2 = PredefinedMenuItem::separator(app)?;

    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    Menu::with_items(app, &[
        &status_item,
        &sep1,
        &connect_item,
        &pause_item,
        &panel_item,
        &sep2,
        &quit_item,
    ])
}

fn update_tray_menu<R: Runtime>(
    app: &AppHandle<R>,
    status: &str,
    paused: bool,
) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let menu = build_tray_menu(app, status, paused).map_err(|e| e.to_string())?;
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn rc_inject_input(event: rc::RcInputEvent) -> Result<(), String> {
    rc::inject(event)
}

#[tauri::command]
async fn rc_capture_frame(quality: u8) -> tauri::ipc::Response {
    // Capture is blocking (GDI + JPEG encode); keep it off the async runtime's
    // worker so it never stalls other IPC. Raw JPEG bytes are returned via
    // tauri::ipc::Response so the WebView receives an ArrayBuffer (no base64
    // inflation); an empty buffer signals "frame unavailable" to the caller.
    let bytes = tokio::task::spawn_blocking(move || rc::capture_primary_jpeg(quality))
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    tauri::ipc::Response::new(bytes)
}

#[tauri::command]
fn set_tray_status<R: Runtime>(app: AppHandle<R>, status: String, paused: bool) -> Result<(), String> {
    let tray = app.tray_by_id("main-tray").ok_or_else(|| "tray not found".to_string())?;
    let icon = Image::from_bytes(tray_icon_bytes(&status)).map_err(|e| e.to_string())?;
    tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;
    let label = status_label(&status);
    tray.set_tooltip(Some(format!("HeySure Agent — {label}"))).map_err(|e| e.to_string())?;
    let _ = update_tray_menu(&app, &status, paused);
    Ok(())
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn setup_tray<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let menu = build_tray_menu(app.handle(), "disconnected", false)?;
    let mut tray = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("HeySure Agent — 未连接")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open-panel" => show_main_window(app),
            "quit" => {
                guard::kill_all_processes();
                app.exit(0);
            }
            "toggle-connect" => {
                let _ = app.emit("tray:toggle-connect", ());
            }
            "toggle-pause" => {
                if guard::is_paused() {
                    guard::resume_execution();
                } else {
                    let _ = guard::pause_execution();
                }
                let _ = app.emit("tray:pause-toggled", ());
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(&tray.app_handle());
            }
        });
    tray = tray.icon(Image::from_bytes(tray_icon_bytes("disconnected"))?);
    tray.build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            setup_tray(app)?;

            // Set main window icon (affects taskbar, Alt+Tab, etc.).
            // Using PNG for reliable tauri::image::Image loading.
            if let Some(main_window) = app.get_webview_window("main") {
                if let Ok(icon) = Image::from_bytes(include_bytes!("../../assets/desktop.png")) {
                    let _ = main_window.set_icon(icon);
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // 常驻托盘：关闭窗口只隐藏，不退出（与 Electron 版行为一致）。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            run_process,
            pause_execution,
            resume_execution,
            kill_all_processes,
            execution_state,
            host_info,
            app_paths,
            which_command,
            file_exists,
            ensure_dir,
            config_paths,
            load_json_file,
            save_json_file,
            write_temp_script,
            remove_temp_dir,
            rc_inject_input,
            rc_capture_frame,
            set_tray_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
