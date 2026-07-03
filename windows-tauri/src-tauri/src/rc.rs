// remote-control input injection — Rust port of
// device/windows/src/remote/input-injector.ts. The Electron shell injected the
// normalized pointer/keyboard events that arrive over the WebRTC control
// DataChannel through robotjs; here the WebView peer (src/remote-control.ts)
// relays each event to this command and we drive the OS with `enigo`
// (robotjs equivalent).
//
// Coordinates are normalized to [0,1] of the primary screen so the browser
// never needs the device's pixel size; we scale by enigo's own primary-display
// size — the same space getDisplayMedia captures — so a click lands where the
// operator aimed regardless of DPI scaling.

use enigo::{
    Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings,
};
use serde::Deserialize;

// ---------------------------------------------------------------------------
// Screen capture
//
// The Electron shell captured the primary screen silently via desktopCapturer.
// WebView2 has no equivalent — its only web API is getDisplayMedia, which pops a
// "share your screen" picker/indicator. To keep remote control a *direct* control
// (no screen-sharing UI), we capture natively here with `xcap` (GDI), JPEG-encode
// the frame, and hand the WebView the *raw JPEG bytes* (via tauri::ipc::Response,
// so `invoke` receives an ArrayBuffer — no base64, no ~33% string inflation, no
// slow string marshaling on the IPC boundary). The WebView decodes with
// createImageBitmap, draws it to a <canvas>, and uses canvas.captureStream() as
// the WebRTC video track, so the operator sees the live screen without any share
// prompt. Returning bytes instead of a base64 data URL is what lets us push the
// capture rate up without saturating the IPC channel.
// ---------------------------------------------------------------------------

/// Capture the primary monitor and return raw ``image/jpeg`` bytes, or ``None`` if
/// capture is unavailable (no desktop session, locked screen, …). ``quality`` is
/// the JPEG quality 1–100. Never panics — a failed frame is just a dropped frame,
/// the stream continues with the previous one.
pub fn capture_primary_jpeg(quality: u8) -> Option<Vec<u8>> {
    let monitors = xcap::Monitor::all().ok()?;
    let monitor = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())?;

    let rgba = monitor.capture_image().ok()?;
    let (width, height) = (rgba.width(), rgba.height());
    // JPEG has no alpha channel — drop it before encoding.
    let rgb = image::DynamicImage::ImageRgba8(rgba).to_rgb8();

    // Pre-size the buffer to roughly one byte per pixel to avoid repeated
    // reallocations during encode (a JPEG frame is well under this at any sane
    // quality).
    let mut buf: Vec<u8> = Vec::with_capacity((width as usize) * (height as usize));
    let mut encoder =
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality.clamp(1, 100));
    encoder
        .encode(rgb.as_raw(), width, height, image::ExtendedColorType::Rgb8)
        .ok()?;

    Some(buf)
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RcInputEvent {
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub button: Option<String>,
    #[serde(default)]
    pub double: bool,
    #[serde(default)]
    pub dx: Option<f64>,
    #[serde(default)]
    pub dy: Option<f64>,
    // keyboard
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub action: Option<String>,
    #[serde(default)]
    pub ctrl: bool,
    #[serde(default)]
    pub alt: bool,
    #[serde(default)]
    pub shift: bool,
    #[serde(default)]
    pub meta: bool,
    #[serde(default)]
    pub text: Option<String>,
}

fn mouse_button(value: &Option<String>) -> Button {
    match value.as_deref() {
        Some("right") => Button::Right,
        Some("middle") => Button::Middle,
        _ => Button::Left,
    }
}

/// Map a browser ``KeyboardEvent.key`` to an enigo key. Printable single
/// characters become ``Key::Unicode``; named keys are translated. Unknown named
/// keys return ``None`` so a stray key never tears down the session.
fn map_key(key: &str) -> Option<Key> {
    if key.is_empty() {
        return None;
    }
    let mut chars = key.chars();
    let first = chars.next();
    if let (Some(c), None) = (first, chars.next()) {
        // Single character — type it as-is (lower-cased to match the physical
        // key; shift state is carried by the modifier flags).
        let lowered = c.to_lowercase().next().unwrap_or(c);
        return Some(Key::Unicode(lowered));
    }
    let mapped = match key {
        "Enter" => Key::Return,
        "Tab" => Key::Tab,
        "Backspace" => Key::Backspace,
        "Delete" => Key::Delete,
        "Escape" => Key::Escape,
        " " | "Spacebar" => Key::Space,
        "ArrowUp" => Key::UpArrow,
        "ArrowDown" => Key::DownArrow,
        "ArrowLeft" => Key::LeftArrow,
        "ArrowRight" => Key::RightArrow,
        "Home" => Key::Home,
        "End" => Key::End,
        "PageUp" => Key::PageUp,
        "PageDown" => Key::PageDown,
        "Control" => Key::Control,
        "Alt" => Key::Alt,
        "Shift" => Key::Shift,
        "Meta" => Key::Meta,
        "CapsLock" => Key::CapsLock,
        "Insert" => Key::Insert,
        "F1" => Key::F1,
        "F2" => Key::F2,
        "F3" => Key::F3,
        "F4" => Key::F4,
        "F5" => Key::F5,
        "F6" => Key::F6,
        "F7" => Key::F7,
        "F8" => Key::F8,
        "F9" => Key::F9,
        "F10" => Key::F10,
        "F11" => Key::F11,
        "F12" => Key::F12,
        _ => return None,
    };
    Some(mapped)
}

fn modifier_keys(event: &RcInputEvent) -> Vec<Key> {
    let mut mods = Vec::new();
    if event.ctrl {
        mods.push(Key::Control);
    }
    if event.alt {
        mods.push(Key::Alt);
    }
    if event.shift {
        mods.push(Key::Shift);
    }
    if event.meta {
        mods.push(Key::Meta);
    }
    mods
}

/// Apply one input event. Never returns an error the caller must handle: a bad
/// event or a transient injection failure must not tear down the control
/// session, so everything is swallowed into an ``Ok(())`` (mirroring the
/// try/catch in input-injector.ts).
pub fn inject(event: RcInputEvent) -> Result<(), String> {
    let mut enigo = match Enigo::new(&Settings::default()) {
        Ok(enigo) => enigo,
        // enigo unavailable (no desktop session, etc.) — drop the event.
        Err(_) => return Ok(()),
    };

    // Normalized [0,1] → absolute pixels on the primary display. move_mouse(Abs)
    // re-normalizes by the same metric, so the ratio is DPI-independent.
    let (screen_w, screen_h) = enigo.main_display().unwrap_or((0, 0));
    let px = |n: Option<f64>| -> i32 {
        (n.unwrap_or(0.0).clamp(0.0, 1.0) * screen_w as f64).round() as i32
    };
    let py = |n: Option<f64>| -> i32 {
        (n.unwrap_or(0.0).clamp(0.0, 1.0) * screen_h as f64).round() as i32
    };

    match event.kind.as_str() {
        "move" => {
            let _ = enigo.move_mouse(px(event.x), py(event.y), Coordinate::Abs);
        }
        "down" => {
            let _ = enigo.move_mouse(px(event.x), py(event.y), Coordinate::Abs);
            let _ = enigo.button(mouse_button(&event.button), Direction::Press);
        }
        "up" => {
            let _ = enigo.move_mouse(px(event.x), py(event.y), Coordinate::Abs);
            let _ = enigo.button(mouse_button(&event.button), Direction::Release);
        }
        "click" => {
            let _ = enigo.move_mouse(px(event.x), py(event.y), Coordinate::Abs);
            let button = mouse_button(&event.button);
            let _ = enigo.button(button, Direction::Click);
            if event.double {
                let _ = enigo.button(button, Direction::Click);
            }
        }
        "scroll" => {
            // Browser wheel deltas are pixels (positive = down); enigo takes
            // discrete steps, so scale down and invert to match natural scroll.
            let dx = (event.dx.unwrap_or(0.0) / -40.0).round() as i32;
            let dy = (event.dy.unwrap_or(0.0) / -40.0).round() as i32;
            if dx != 0 {
                let _ = enigo.scroll(dx, Axis::Horizontal);
            }
            if dy != 0 {
                let _ = enigo.scroll(dy, Axis::Vertical);
            }
        }
        "key" => {
            let Some(key) = event.key.as_deref().and_then(map_key) else {
                return Ok(());
            };
            let mods = modifier_keys(&event);
            match event.action.as_deref() {
                Some("down") => {
                    let _ = enigo.key(key, Direction::Press);
                }
                Some("up") => {
                    let _ = enigo.key(key, Direction::Release);
                }
                // "tap" (or unspecified): hold any modifiers, click, release.
                _ => {
                    for m in &mods {
                        let _ = enigo.key(*m, Direction::Press);
                    }
                    let _ = enigo.key(key, Direction::Click);
                    for m in mods.iter().rev() {
                        let _ = enigo.key(*m, Direction::Release);
                    }
                }
            }
        }
        "text" => {
            // Only IME-composed text (e.g. 中文) reaches here — plain ASCII is
            // typed natively via key down/up. enigo.text() drives KEYEVENTF_UNICODE
            // so it handles CJK directly (no clipboard round-trip needed).
            if let Some(text) = event.text.as_deref() {
                if !text.is_empty() {
                    let _ = enigo.text(text);
                }
            }
        }
        _ => {}
    }
    Ok(())
}
