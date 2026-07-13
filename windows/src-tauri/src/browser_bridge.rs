//! Loopback bridge for the browser_MCP_win extension.
//!
//! The extension is deliberately a read-only DOM/geometry sensor. It posts a
//! small command to this listener and the Windows process injects
//! the actual mouse/keyboard gesture through enigo. The listener never binds a
//! LAN interface and rejects ordinary web-page origins.

use crate::rc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::Duration;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumChildWindows, EnumWindows, GetClassNameW, GetForegroundWindow, GetWindow,
    GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
    PostMessageW, SetForegroundWindow, SetWindowPos, ShowWindowAsync, SwitchToThisWindow, GW_OWNER,
    HWND_TOP, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_RESTORE, WM_CLOSE,
};

pub const PORT: u16 = 38473;
// A multiline editor payload can easily exceed 64 KiB once JSON escaping and
// UTF-8 expansion are included. Keep a finite loopback-only cap while allowing
// genuinely long type actions to arrive intact.
const MAX_BODY: u64 = 1024 * 1024;

#[derive(Default)]
struct BridgeConfig {
    enabled: bool,
}

fn config() -> &'static RwLock<BridgeConfig> {
    static CONFIG: OnceLock<RwLock<BridgeConfig>> = OnceLock::new();
    CONFIG.get_or_init(|| RwLock::new(BridgeConfig::default()))
}

static RUNNING: AtomicBool = AtomicBool::new(false);
static INPUT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    pub url: String,
    pub port: u16,
    pub running: bool,
    pub enabled: bool,
}

pub fn configure(enabled: bool) -> Result<BridgeInfo, String> {
    let mut state = config()
        .write()
        .map_err(|_| "bridge config lock poisoned".to_string())?;
    state.enabled = enabled;
    drop(state);
    Ok(info())
}

pub fn info() -> BridgeInfo {
    let state = config().read().ok();
    BridgeInfo {
        url: format!("http://127.0.0.1:{PORT}"),
        port: PORT,
        running: RUNNING.load(Ordering::SeqCst),
        enabled: state.as_ref().map(|s| s.enabled).unwrap_or(false),
    }
}

pub fn start() {
    std::thread::Builder::new()
        .name("heysure-browser-bridge".to_string())
        .spawn(|| {
            let Ok(server) = Server::http(("127.0.0.1", PORT)) else {
                eprintln!("browser bridge could not bind 127.0.0.1:{PORT}");
                return;
            };
            RUNNING.store(true, Ordering::SeqCst);
            for request in server.incoming_requests() {
                handle_request(request);
            }
            RUNNING.store(false, Ordering::SeqCst);
        })
        .ok();
}

fn header(request: &Request, name: &'static str) -> String {
    request
        .headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str().to_string())
        .unwrap_or_default()
}

fn response_header(name: &str, value: &str) -> Option<Header> {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).ok()
}

fn respond(request: Request, status: u16, value: Value, origin: &str) {
    let mut response =
        Response::from_string(value.to_string()).with_status_code(StatusCode(status));
    if let Some(h) = response_header("Content-Type", "application/json; charset=utf-8") {
        response.add_header(h);
    }
    if !origin.is_empty() {
        if let Some(h) = response_header("Access-Control-Allow-Origin", origin) {
            response.add_header(h);
        }
    }
    if let Some(h) = response_header("Access-Control-Allow-Headers", "Content-Type") {
        response.add_header(h);
    }
    if let Some(h) = response_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS") {
        response.add_header(h);
    }
    if let Some(h) = response_header("Cache-Control", "no-store") {
        response.add_header(h);
    }
    let _ = request.respond(response);
}

fn ensure_enabled() -> Result<(), (&'static str, &'static str)> {
    let state = config()
        .read()
        .map_err(|_| ("BRIDGE_STATE_ERROR", "bridge state unavailable"))?;
    if !state.enabled {
        return Err((
            "BRIDGE_DISABLED",
            "Windows browser input bridge is disabled",
        ));
    }
    Ok(())
}

fn handle_request(mut request: Request) {
    let origin = header(&request, "Origin");
    if !origin.is_empty() && !origin.starts_with("chrome-extension://") {
        respond(
            request,
            403,
            json!({ "success": false, "code": "BRIDGE_ORIGIN_REJECTED", "error": "only Chrome extension origins are allowed" }),
            "",
        );
        return;
    }
    if request.method() == &Method::Options {
        respond(request, 204, json!({}), &origin);
        return;
    }
    if let Err((code, message)) = ensure_enabled() {
        respond(
            request,
            403,
            json!({ "success": false, "code": code, "error": message }),
            &origin,
        );
        return;
    }
    if request.method() == &Method::Get && request.url() == "/v1/health" {
        let bridge = info();
        respond(
            request,
            200,
            json!({
                "success": true,
                "version": 1,
                "running": bridge.running,
                "enabled": bridge.enabled,
            }),
            &origin,
        );
        return;
    }
    if request.method() != &Method::Post || request.url() != "/v1/input" {
        respond(
            request,
            404,
            json!({ "success": false, "code": "NOT_FOUND", "error": "not found" }),
            &origin,
        );
        return;
    }

    let mut bytes = Vec::new();
    let read = request
        .as_reader()
        .take(MAX_BODY + 1)
        .read_to_end(&mut bytes);
    if read.is_err() || bytes.len() as u64 > MAX_BODY {
        respond(
            request,
            413,
            json!({ "success": false, "code": "BRIDGE_BODY_TOO_LARGE", "error": "request body is too large" }),
            &origin,
        );
        return;
    }
    let command: InputRequest = match serde_json::from_slice(&bytes) {
        Ok(command) => command,
        Err(error) => {
            respond(
                request,
                400,
                json!({ "success": false, "code": "BRIDGE_BAD_JSON", "error": error.to_string() }),
                &origin,
            );
            return;
        }
    };
    let result = execute(&command);
    match result {
        Ok(result) => respond(
            request,
            200,
            json!({
                "success": true,
                "method": "windows.enigo",
                "action": command.action,
                "result": result,
            }),
            &origin,
        ),
        Err((code, message)) => respond(
            request,
            409,
            json!({
                "success": false,
                "code": code,
                "error": message,
            }),
            &origin,
        ),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InputRequest {
    #[serde(default)]
    version: u8,
    action: String,
    #[serde(default)]
    point: Option<Point>,
    #[serde(default)]
    to_point: Option<Point>,
    #[serde(default)]
    button: Option<String>,
    #[serde(default)]
    double: bool,
    #[serde(default)]
    direction: Option<String>,
    #[serde(default)]
    amount: Option<i32>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    clear_first: bool,
    #[serde(default)]
    submit: bool,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    ctrl: bool,
    #[serde(default)]
    shift: bool,
    #[serde(default)]
    alt: bool,
    #[serde(default)]
    meta: bool,
    #[serde(default)]
    repeat: Option<u16>,
    #[serde(default)]
    new_tab: bool,
    #[serde(default)]
    tab: BrowserTab,
    #[serde(default)]
    window: Option<BrowserWindowMetrics>,
    #[serde(default)]
    viewport: Option<Viewport>,
}

#[derive(Clone, Copy, Deserialize)]
struct Point {
    x: f64,
    y: f64,
}

#[derive(Default, Deserialize)]
struct BrowserTab {
    #[serde(default)]
    title: String,
}

#[derive(Deserialize)]
struct BrowserWindowMetrics {
    #[serde(default)]
    left: Option<f64>,
    #[serde(default)]
    top: Option<f64>,
    #[serde(default)]
    width: Option<f64>,
    #[serde(default)]
    height: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Viewport {
    screen_x: f64,
    screen_y: f64,
    #[serde(default)]
    outer_width: f64,
    #[serde(default)]
    outer_height: f64,
    inner_width: f64,
    inner_height: f64,
    #[serde(default = "default_page_zoom")]
    page_zoom: f64,
    screen: ScreenMetrics,
}

fn default_page_zoom() -> f64 {
    1.0
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScreenMetrics {
    left: f64,
    top: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Copy)]
struct BrowserWindow {
    hwnd: HWND,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct MappingRect {
    left: i32,
    top: i32,
    width: i32,
    height: i32,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct MappedPoint {
    x: i32,
    y: i32,
    mapping_method: &'static str,
    content_rect: MappingRect,
    scale_x: f64,
    scale_y: f64,
}

impl MappedPoint {
    fn coordinates(self) -> (i32, i32) {
        (self.x, self.y)
    }
}

fn window_text(hwnd: HWND) -> String {
    let mut buffer = [0u16; 512];
    let len = unsafe { GetWindowTextW(hwnd, &mut buffer) };
    String::from_utf16_lossy(&buffer[..len.max(0) as usize])
}

fn window_class(hwnd: HWND) -> String {
    let mut buffer = [0u16; 128];
    let len = unsafe { GetClassNameW(hwnd, &mut buffer) };
    String::from_utf16_lossy(&buffer[..len.max(0) as usize])
}

// Chromium exposes the active page renderer as a child window whose rectangle
// starts below the tabs/address bar. GetWindowRect on that child gives the
// actual physical page viewport, so no guessed title-bar height or DPI factor
// is needed. Some Chromium versions report this child as not visible even
// while it is the active compositor surface, therefore visibility is not used
// as a filter; zero-sized stale renderers are discarded instead.
unsafe extern "system" fn enum_render_widgets(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if window_class(hwnd) == "Chrome_RenderWidgetHostHWND" {
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_ok()
            && rect.right > rect.left
            && rect.bottom > rect.top
        {
            let rects = &mut *(lparam.0 as *mut Vec<RECT>);
            rects.push(rect);
        }
    }
    BOOL(1)
}

fn chromium_content_rect(hwnd: HWND, viewport: &Viewport) -> Option<RECT> {
    let mut rects: Vec<RECT> = Vec::new();
    unsafe {
        let _ = EnumChildWindows(
            hwnd,
            Some(enum_render_widgets),
            LPARAM(&mut rects as *mut _ as isize),
        );
    }
    if rects.is_empty() || viewport.inner_width <= 0.0 || viewport.inner_height <= 0.0 {
        return None;
    }

    let max_area = rects
        .iter()
        .map(|rect| ((rect.right - rect.left) as f64) * ((rect.bottom - rect.top) as f64))
        .fold(1.0_f64, f64::max);
    let expected_aspect = viewport.inner_width / viewport.inner_height;

    rects.into_iter().min_by(|a, b| {
        let score = |rect: &RECT| {
            let width = (rect.right - rect.left).max(1) as f64;
            let height = (rect.bottom - rect.top).max(1) as f64;
            let area = width * height;
            // The active page has the same aspect ratio as window.innerWidth /
            // window.innerHeight. A small area penalty avoids accidentally
            // selecting a similarly-shaped extension/sidebar renderer.
            ((width / height) / expected_aspect).ln().abs() + 0.02 * ((max_area / area) - 1.0)
        };
        score(a)
            .partial_cmp(&score(b))
            .unwrap_or(std::cmp::Ordering::Equal)
    })
}

fn is_browser_window(hwnd: HWND) -> bool {
    let class = window_class(hwnd);
    class.starts_with("Chrome_WidgetWin_") || class == "MozillaWindowClass"
}

unsafe extern "system" fn enum_browser_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if IsWindowVisible(hwnd).as_bool() && is_browser_window(hwnd) {
        let windows = &mut *(lparam.0 as *mut Vec<BrowserWindow>);
        windows.push(BrowserWindow { hwnd });
    }
    BOOL(1)
}

fn browser_windows() -> Vec<BrowserWindow> {
    let mut windows = Vec::new();
    unsafe {
        let _ = EnumWindows(
            Some(enum_browser_window),
            LPARAM(&mut windows as *mut _ as isize),
        );
    }
    windows
}

fn normalized_title(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn is_foreground(hwnd: HWND) -> bool {
    unsafe { GetForegroundWindow() == hwnd }
}

fn window_process_id(hwnd: HWND) -> u32 {
    let mut process_id = 0u32;
    unsafe {
        let _ = GetWindowThreadProcessId(hwnd, Some(&mut process_id));
    }
    process_id
}

// A trusted click on <input type=file> can leave a Win32 file picker in front
// of Chrome. It is a separate #32770 window, so the browser itself can no
// longer become foreground. Close only a system dialog owned by the exact
// target browser process, or whose Win32 owner chain reaches that browser. The
// owner check covers OS-hosted dialogs that run in a helper process without
// widening this to unrelated editors or desktop applications.
fn is_owned_by(dialog: HWND, browser: HWND) -> bool {
    let mut current = dialog;
    for _ in 0..8 {
        current = unsafe { GetWindow(current, GW_OWNER) };
        if current.0 == 0 {
            return false;
        }
        if current == browser {
            return true;
        }
    }
    false
}

fn dismiss_owned_system_dialog(browser: HWND) -> bool {
    let dialog = unsafe { GetForegroundWindow() };
    if dialog.0 == 0
        || window_class(dialog) != "#32770"
        || (window_process_id(dialog) != window_process_id(browser)
            && !is_owned_by(dialog, browser))
    {
        return false;
    }
    if unsafe { PostMessageW(dialog, WM_CLOSE, WPARAM(0), LPARAM(0)) }.is_err() {
        return false;
    }
    std::thread::sleep(Duration::from_millis(160));
    true
}

// SetForegroundWindow alone is intentionally throttled by Windows when the
// caller is a background process. Temporarily joining the input queues of this
// bridge thread, the current foreground thread, and the browser thread grants
// the same activation path a user-initiated window switch has. If the desktop
// policy still rejects it, SwitchToThisWindow is the final Alt+Tab-style
// fallback. Attachments are always removed before returning.
fn activate_browser_window(hwnd: HWND) -> bool {
    if is_foreground(hwnd) {
        return true;
    }

    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindowAsync(hwnd, SW_RESTORE);
            std::thread::sleep(Duration::from_millis(80));
        }

        let foreground = GetForegroundWindow();
        let current_thread = GetCurrentThreadId();
        let foreground_thread = if foreground.0 != 0 {
            GetWindowThreadProcessId(foreground, None)
        } else {
            0
        };
        let target_thread = GetWindowThreadProcessId(hwnd, None);

        let attached_foreground = foreground_thread != 0
            && foreground_thread != current_thread
            && AttachThreadInput(current_thread, foreground_thread, true).as_bool();
        let attached_target = target_thread != 0
            && target_thread != current_thread
            && target_thread != foreground_thread
            && AttachThreadInput(current_thread, target_thread, true).as_bool();

        let _ = BringWindowToTop(hwnd);
        let _ = SetWindowPos(
            hwnd,
            HWND_TOP,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
        );
        let _ = SetForegroundWindow(hwnd);

        if attached_target {
            let _ = AttachThreadInput(current_thread, target_thread, false);
        }
        if attached_foreground {
            let _ = AttachThreadInput(current_thread, foreground_thread, false);
        }
    }

    std::thread::sleep(Duration::from_millis(120));
    if is_foreground(hwnd) {
        return true;
    }

    unsafe {
        // This is the same switch primitive used by the shell for a requested
        // application change and succeeds in cases where foreground-lock
        // timeout blocks SetForegroundWindow.
        SwitchToThisWindow(hwnd, true);
    }
    std::thread::sleep(Duration::from_millis(180));
    is_foreground(hwnd)
}

fn reported_window_score(
    candidate: BrowserWindow,
    reported: &BrowserWindowMetrics,
    viewport: Option<&Viewport>,
) -> Option<f64> {
    let (left, top, width, height) = (
        reported.left?,
        reported.top?,
        reported.width?,
        reported.height?,
    );
    if width <= 0.0 || height <= 0.0 {
        return None;
    }

    let mut actual = RECT::default();
    unsafe { GetWindowRect(candidate.hwnd, &mut actual).ok()? };
    let actual_width = (actual.right - actual.left).max(1) as f64;
    let actual_height = (actual.bottom - actual.top).max(1) as f64;

    let (expected_left, expected_top, expected_width, expected_height, norm_width, norm_height) =
        if let Some(viewport) =
            viewport.filter(|viewport| viewport.screen.width > 0.0 && viewport.screen.height > 0.0)
        {
            let monitor = monitor_rect(candidate.hwnd).ok()?;
            let monitor_width = (monitor.right - monitor.left).max(1) as f64;
            let monitor_height = (monitor.bottom - monitor.top).max(1) as f64;
            (
                monitor.left as f64
                    + ((left - viewport.screen.left) / viewport.screen.width) * monitor_width,
                monitor.top as f64
                    + ((top - viewport.screen.top) / viewport.screen.height) * monitor_height,
                (width / viewport.screen.width) * monitor_width,
                (height / viewport.screen.height) * monitor_height,
                monitor_width,
                monitor_height,
            )
        } else {
            (left, top, width, height, width.max(1.0), height.max(1.0))
        };

    Some(
        ((actual.left as f64 - expected_left).abs() + (actual_width - expected_width).abs())
            / norm_width
            + ((actual.top as f64 - expected_top).abs() + (actual_height - expected_height).abs())
                / norm_height,
    )
}

fn focus_browser(
    title: &str,
    reported_window: Option<&BrowserWindowMetrics>,
    viewport: Option<&Viewport>,
    target_owned_modal: bool,
) -> Result<HWND, (&'static str, String)> {
    let desired = normalized_title(title);
    let foreground = unsafe { GetForegroundWindow() };
    let windows = browser_windows();
    let title_matches = windows
        .iter()
        .filter(|candidate| {
            if desired.is_empty() {
                return false;
            }
            let actual = normalized_title(&window_text(candidate.hwnd));
            !actual.is_empty() && (actual.contains(&desired) || desired.contains(&actual))
        })
        .copied()
        .collect::<Vec<_>>();
    let foreground_browser = windows
        .iter()
        .find(|candidate| candidate.hwnd == foreground)
        .copied();
    let candidate = if desired.is_empty() {
        foreground_browser.or_else(|| windows.first().copied())
    } else {
        reported_window
            .and_then(|reported| {
                title_matches.iter().copied().min_by(|a, b| {
                    let a_score =
                        reported_window_score(*a, reported, viewport).unwrap_or(f64::INFINITY);
                    let b_score =
                        reported_window_score(*b, reported, viewport).unwrap_or(f64::INFINITY);
                    a_score
                        .partial_cmp(&b_score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
            })
            .or_else(|| {
                title_matches
                    .iter()
                    .find(|candidate| candidate.hwnd == foreground)
                    .copied()
            })
            .or_else(|| title_matches.first().copied())
    }
    .ok_or((
        "BRIDGE_BROWSER_NOT_FOUND",
        if desired.is_empty() {
            "No supported browser window is open".to_string()
        } else {
            format!("No browser window matches the active tab title: {title}")
        },
    ))?;

    let _ = dismiss_owned_system_dialog(candidate.hwnd);
    if target_owned_modal {
        // Chromium can host HTTP-auth, permission and JavaScript dialogs in a
        // separate owned top-level HWND. Activating the main window is blocked
        // while that modal owns input, so deliver Escape to the already-
        // foreground owned window instead.
        let modal = unsafe { GetForegroundWindow() };
        if modal.0 != 0 && modal != candidate.hwnd && is_owned_by(modal, candidate.hwnd) {
            return Ok(modal);
        }
    }
    if !activate_browser_window(candidate.hwnd) {
        return Err((
            "BRIDGE_BROWSER_NOT_FOREGROUND",
            "Windows blocked automatic browser activation after all foreground-switch fallbacks. Unlock the desktop and retry.".to_string(),
        ));
    }
    Ok(candidate.hwnd)
}

fn monitor_rect(hwnd: HWND) -> Result<RECT, (&'static str, String)> {
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
        return Err((
            "BRIDGE_MONITOR_ERROR",
            "Unable to read the browser monitor geometry".to_string(),
        ));
    }
    Ok(info.rcMonitor)
}

fn physical_point(
    hwnd: HWND,
    viewport: Option<&Viewport>,
    point: Option<Point>,
) -> Result<Option<MappedPoint>, (&'static str, String)> {
    let Some(point) = point else { return Ok(None) };
    let viewport = viewport.ok_or((
        "BRIDGE_VIEWPORT_REQUIRED",
        "DOM viewport metrics are required for a coordinate action".to_string(),
    ))?;
    if viewport.inner_width <= 0.0 || viewport.inner_height <= 0.0 {
        return Err((
            "BRIDGE_BAD_VIEWPORT",
            "Invalid browser viewport dimensions".to_string(),
        ));
    }

    if !(-1.0..=viewport.inner_width + 1.0).contains(&point.x)
        || !(-1.0..=viewport.inner_height + 1.0).contains(&point.y)
    {
        return Err((
            "BRIDGE_POINT_OUTSIDE_VIEWPORT",
            "The resolved DOM point is outside the current page viewport".to_string(),
        ));
    }

    if let Some(rect) = chromium_content_rect(hwnd, viewport) {
        let width = (rect.right - rect.left).max(1);
        let height = (rect.bottom - rect.top).max(1);
        let scale_x = width as f64 / viewport.inner_width;
        let scale_y = height as f64 / viewport.inner_height;
        return Ok(Some(MappedPoint {
            x: rect.left + (point.x * scale_x).round() as i32,
            y: rect.top + (point.y * scale_y).round() as i32,
            mapping_method: "chromium.render_widget_rect",
            content_rect: MappingRect {
                left: rect.left,
                top: rect.top,
                width,
                height,
            },
            scale_x,
            scale_y,
        }));
    }

    if viewport.screen.width <= 0.0 || viewport.screen.height <= 0.0 {
        return Err((
            "BRIDGE_BAD_VIEWPORT",
            "Invalid browser screen metrics".to_string(),
        ));
    }

    // Firefox and Chromium variants without a render-widget HWND fall back to
    // CSS screen metrics. Account for browser chrome using outer/inner sizes;
    // pageZoom converts DOM CSS pixels into screen-coordinate CSS pixels.
    let zoom = if viewport.page_zoom.is_finite() && viewport.page_zoom > 0.0 {
        viewport.page_zoom
    } else {
        1.0
    };
    let content_width = viewport.inner_width * zoom;
    let content_height = viewport.inner_height * zoom;
    let horizontal_extra = (viewport.outer_width - content_width).max(0.0);
    let frame_border = (horizontal_extra / 2.0).clamp(0.0, 8.0);
    let chrome_top = (viewport.outer_height - content_height - frame_border).max(0.0);
    let content_left_css = viewport.screen_x + frame_border;
    let content_top_css = viewport.screen_y + chrome_top;
    let absolute_css_x = content_left_css + point.x * zoom;
    let absolute_css_y = content_top_css + point.y * zoom;
    let nx = (absolute_css_x - viewport.screen.left) / viewport.screen.width;
    let ny = (absolute_css_y - viewport.screen.top) / viewport.screen.height;
    if !(-0.02..=1.02).contains(&nx) || !(-0.02..=1.02).contains(&ny) {
        return Err((
            "BRIDGE_POINT_OUTSIDE_MONITOR",
            "The resolved DOM point is outside the browser's current monitor; move the window fully onto one display and retry.".to_string(),
        ));
    }
    let rect = monitor_rect(hwnd)?;
    let width = (rect.right - rect.left).max(1) as f64;
    let height = (rect.bottom - rect.top).max(1) as f64;
    let x = rect.left + (nx.clamp(0.0, 1.0) * width).round() as i32;
    let y = rect.top + (ny.clamp(0.0, 1.0) * height).round() as i32;
    let screen_scale_x = width / viewport.screen.width;
    let screen_scale_y = height / viewport.screen.height;
    Ok(Some(MappedPoint {
        x,
        y,
        mapping_method: "browser.screen_metrics_fallback",
        content_rect: MappingRect {
            left: rect.left
                + (((content_left_css - viewport.screen.left) / viewport.screen.width) * width)
                    .round() as i32,
            top: rect.top
                + (((content_top_css - viewport.screen.top) / viewport.screen.height) * height)
                    .round() as i32,
            width: (content_width * screen_scale_x).round() as i32,
            height: (content_height * screen_scale_y).round() as i32,
        },
        scale_x: zoom * screen_scale_x,
        scale_y: zoom * screen_scale_y,
    }))
}

fn execute(command: &InputRequest) -> Result<Value, (&'static str, String)> {
    if command.version != 1 {
        return Err((
            "BRIDGE_VERSION_UNSUPPORTED",
            format!("unsupported bridge version: {}", command.version),
        ));
    }
    let _input = INPUT_LOCK.lock().map_err(|_| {
        (
            "BRIDGE_INPUT_BUSY",
            "native input lock is unavailable".to_string(),
        )
    })?;
    let hwnd = focus_browser(
        &command.tab.title,
        command.window.as_ref(),
        command.viewport.as_ref(),
        command.action == "dismiss_dialog",
    )?;
    let point = physical_point(hwnd, command.viewport.as_ref(), command.point)?;
    let to_point = physical_point(hwnd, command.viewport.as_ref(), command.to_point)?;
    let map_error = |error: String| ("BRIDGE_INJECTION_FAILED", error);

    match command.action.as_str() {
        "click" => {
            let point = point.ok_or((
                "BRIDGE_POINT_REQUIRED",
                "click requires a DOM point".to_string(),
            ))?;
            let (x, y) = point.coordinates();
            rc::native_click(
                x,
                y,
                command.button.as_deref().unwrap_or("left"),
                command.double,
            )
            .map_err(map_error)?;
        }
        "scroll" => {
            rc::native_scroll(
                point.map(MappedPoint::coordinates),
                command.direction.as_deref().unwrap_or("down"),
                command.amount.unwrap_or(400),
            )
            .map_err(map_error)?;
        }
        "type" => {
            let point = point.ok_or((
                "BRIDGE_POINT_REQUIRED",
                "type requires an input-element point".to_string(),
            ))?;
            rc::native_type(
                point.coordinates(),
                command.text.as_deref().unwrap_or(""),
                command.clear_first,
                command.submit,
            )
            .map_err(map_error)?;
        }
        "key" => {
            rc::native_key(
                point.map(MappedPoint::coordinates),
                command.key.as_deref().unwrap_or(""),
                command.ctrl,
                command.shift,
                command.alt,
                command.meta,
                command.repeat.unwrap_or(1),
            )
            .map_err(map_error)?;
        }
        "navigate" => {
            rc::native_navigate(command.text.as_deref().unwrap_or(""), command.new_tab)
                .map_err(map_error)?;
        }
        "dismiss_dialog" => {
            rc::native_dismiss_dialog().map_err(map_error)?;
        }
        "drag" => {
            let from = point.ok_or((
                "BRIDGE_POINT_REQUIRED",
                "drag requires a source point".to_string(),
            ))?;
            let to = to_point.ok_or((
                "BRIDGE_POINT_REQUIRED",
                "drag requires a destination point".to_string(),
            ))?;
            rc::native_drag(from.coordinates(), to.coordinates()).map_err(map_error)?;
        }
        _ => {
            return Err((
                "BRIDGE_ACTION_UNSUPPORTED",
                format!("unsupported native action: {}", command.action),
            ))
        }
    }

    Ok(json!({
        "physicalPoint": point,
        "physicalToPoint": to_point,
    }))
}
