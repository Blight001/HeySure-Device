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

use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serde::Deserialize;
use std::sync::{Mutex, OnceLock};
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, GetObjectW, ReleaseDC,
    SelectObject, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBRUSH, HGDIOBJ,
};
use windows::Win32::UI::WindowsAndMessaging::{
    DrawIconEx, GetCursorInfo, GetIconInfo, CURSORINFO, CURSOR_SHOWING, DI_NORMAL, HICON, ICONINFO,
};

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

    let mut rgba = monitor.capture_image().ok()?;
    // xcap's GDI BitBlt capture never includes the hardware cursor — it's a
    // hardware overlay plane, not part of the framebuffer BitBlt reads. Without
    // drawing it back in, the operator sees no pointer at all and none of the
    // hover-state shape changes (arrow/I-beam/hand/resize) that make a remote
    // desktop legible. Best-effort: any Win32 call failing just leaves the frame
    // without a cursor, never drops it.
    let mon_left = monitor.x().unwrap_or(0);
    let mon_top = monitor.y().unwrap_or(0);
    draw_cursor_overlay(&mut rgba, mon_left, mon_top);

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

/// Draw the live OS cursor onto a captured frame at its true screen position.
/// `GetCursorInfo`/`GetIconInfo` hand us the cursor's bitmap and hotspot;
/// `DrawIconEx` renders it into a 32bpp DIB we composite by alpha over the
/// frame. `mon_left`/`mon_top` convert the cursor's virtual-screen position
/// into the captured monitor's local pixel space.
fn draw_cursor_overlay(image: &mut image::RgbaImage, mon_left: i32, mon_top: i32) {
    unsafe {
        let mut info = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        if GetCursorInfo(&mut info).is_err() || info.flags != CURSOR_SHOWING {
            return;
        }
        let hcursor = info.hCursor;
        if hcursor.is_invalid() {
            return;
        }

        let mut icon_info = ICONINFO::default();
        if GetIconInfo(HICON::from(hcursor), &mut icon_info).is_err() {
            return;
        }
        let hbm_mask = icon_info.hbmMask;
        let hbm_color = icon_info.hbmColor;
        let free_bitmaps = || {
            if !hbm_mask.is_invalid() {
                let _ = DeleteObject(HGDIOBJ::from(hbm_mask));
            }
            if !hbm_color.is_invalid() {
                let _ = DeleteObject(HGDIOBJ::from(hbm_color));
            }
        };

        // Determine the cursor's pixel size — monochrome cursors only have
        // hbmMask (double height: AND mask on top, XOR mask on bottom).
        let size_source = if !hbm_color.is_invalid() { hbm_color } else { hbm_mask };
        let mut bmp = BITMAP::default();
        if size_source.is_invalid()
            || GetObjectW(
                HGDIOBJ::from(size_source),
                std::mem::size_of::<BITMAP>() as i32,
                Some(&mut bmp as *mut BITMAP as *mut core::ffi::c_void),
            ) == 0
        {
            free_bitmaps();
            return;
        }
        let width = bmp.bmWidth;
        let height = if hbm_color.is_invalid() { bmp.bmHeight / 2 } else { bmp.bmHeight };
        if width <= 0 || height <= 0 {
            free_bitmaps();
            return;
        }

        let screen_dc = GetDC(HWND::default());
        let mem_dc = CreateCompatibleDC(screen_dc);
        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // negative = top-down DIB, matches our RgbaImage row order
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits_ptr: *mut core::ffi::c_void = std::ptr::null_mut();
        let dib = CreateDIBSection(mem_dc, &bmi, DIB_RGB_COLORS, &mut bits_ptr, None, 0);

        if let Ok(dib) = dib {
            if !dib.is_invalid() && !bits_ptr.is_null() {
                let prev = SelectObject(mem_dc, HGDIOBJ::from(dib));
                // Zero the buffer first: DrawIconEx composites the cursor onto
                // whatever is already there, and a zeroed 32bpp buffer
                // (alpha = 0 everywhere) is exactly the transparent canvas it
                // expects to draw over.
                std::ptr::write_bytes(
                    bits_ptr as *mut u8,
                    0,
                    (width as usize) * (height as usize) * 4,
                );
                let _ = DrawIconEx(
                    mem_dc,
                    0,
                    0,
                    HICON::from(hcursor),
                    width,
                    height,
                    0,
                    HBRUSH::default(),
                    DI_NORMAL,
                );

                let pixels = std::slice::from_raw_parts(
                    bits_ptr as *const u8,
                    (width as usize) * (height as usize) * 4,
                );
                let origin_x = info.ptScreenPos.x - mon_left - icon_info.xHotspot as i32;
                let origin_y = info.ptScreenPos.y - mon_top - icon_info.yHotspot as i32;

                for y in 0..height {
                    let dest_y = origin_y + y;
                    if dest_y < 0 || dest_y as u32 >= image.height() {
                        continue;
                    }
                    for x in 0..width {
                        let dest_x = origin_x + x;
                        if dest_x < 0 || dest_x as u32 >= image.width() {
                            continue;
                        }
                        let idx = ((y as usize) * (width as usize) + (x as usize)) * 4;
                        // BGRA in the DIB.
                        let (b, g, r, a) = (
                            pixels[idx] as u32,
                            pixels[idx + 1] as u32,
                            pixels[idx + 2] as u32,
                            pixels[idx + 3] as u32,
                        );
                        if a == 0 {
                            continue;
                        }
                        let dst = image.get_pixel_mut(dest_x as u32, dest_y as u32);
                        dst[0] = ((r * a + dst[0] as u32 * (255 - a)) / 255) as u8;
                        dst[1] = ((g * a + dst[1] as u32 * (255 - a)) / 255) as u8;
                        dst[2] = ((b * a + dst[2] as u32 * (255 - a)) / 255) as u8;
                    }
                }

                SelectObject(mem_dc, prev);
            }
            let _ = DeleteObject(HGDIOBJ::from(dib));
        }
        let _ = DeleteDC(mem_dc);
        ReleaseDC(HWND::default(), screen_dc);
        free_bitmaps();
    }
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

/// A single character, or ``None`` if ``key`` is empty or a multi-char name
/// (``"Enter"``, ``"ArrowUp"``, …).
fn single_char(key: &str) -> Option<char> {
    let mut chars = key.chars();
    let first = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    Some(first)
}

/// Map an ASCII letter/digit/space to enigo's dedicated virtual-key variant —
/// the *physical* key, independent of case. Typed this way (rather than as
/// `Key::Unicode`) it combines correctly with a modifier that's already held
/// (see `apply`), which is what makes Ctrl+C/Ctrl+V/Ctrl+A and Shift+letter
/// (for the uppercase form) actually work: the real Shift/Ctrl key was pressed
/// as its own physical key event, and the receiving app sees a genuine virtual
/// keycode to combine it with instead of an opaque injected Unicode codepoint.
fn ascii_physical_key(c: char) -> Option<Key> {
    if c == ' ' {
        return Some(Key::Space);
    }
    if c.is_ascii_alphabetic() {
        return Some(match c.to_ascii_uppercase() {
            'A' => Key::A,
            'B' => Key::B,
            'C' => Key::C,
            'D' => Key::D,
            'E' => Key::E,
            'F' => Key::F,
            'G' => Key::G,
            'H' => Key::H,
            'I' => Key::I,
            'J' => Key::J,
            'K' => Key::K,
            'L' => Key::L,
            'M' => Key::M,
            'N' => Key::N,
            'O' => Key::O,
            'P' => Key::P,
            'Q' => Key::Q,
            'R' => Key::R,
            'S' => Key::S,
            'T' => Key::T,
            'U' => Key::U,
            'V' => Key::V,
            'W' => Key::W,
            'X' => Key::X,
            'Y' => Key::Y,
            'Z' => Key::Z,
            _ => unreachable!(),
        });
    }
    if c.is_ascii_digit() {
        return Some(match c {
            '0' => Key::Num0,
            '1' => Key::Num1,
            '2' => Key::Num2,
            '3' => Key::Num3,
            '4' => Key::Num4,
            '5' => Key::Num5,
            '6' => Key::Num6,
            '7' => Key::Num7,
            '8' => Key::Num8,
            '9' => Key::Num9,
            _ => unreachable!(),
        });
    }
    None
}

/// Map a browser named (multi-char) ``KeyboardEvent.key`` to an enigo key.
/// Unknown named keys return ``None`` so a stray key never tears down the
/// session.
fn map_named_key(key: &str) -> Option<Key> {
    let mapped = match key {
        "Enter" => Key::Return,
        "Tab" => Key::Tab,
        "Backspace" => Key::Backspace,
        "Delete" => Key::Delete,
        "Escape" => Key::Escape,
        "Spacebar" => Key::Space,
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

/// Press/release/click one resolved key, honoring ``action`` ("down"/"up"/tap).
fn dispatch_key(enigo: &mut Enigo, key: Key, action: Option<&str>, mods: &[Key]) {
    match action {
        Some("down") => {
            let _ = enigo.key(key, Direction::Press);
        }
        Some("up") => {
            let _ = enigo.key(key, Direction::Release);
        }
        // "tap" (or unspecified): hold any modifiers, click, release.
        _ => {
            for m in mods {
                let _ = enigo.key(*m, Direction::Press);
            }
            let _ = enigo.key(key, Direction::Click);
            for m in mods.iter().rev() {
                let _ = enigo.key(*m, Direction::Release);
            }
        }
    }
}

/// One long-lived Enigo for the process lifetime, guarded by a mutex.
///
/// The previous design created a fresh `Enigo::new()` per event. `Settings`'s
/// default `release_keys_when_dropped` is `true`, so every one of those Enigo
/// instances force-released any key just pressed with `Direction::Press` the
/// moment the function returned and it dropped — a modifier "down" (Ctrl,
/// Shift, Alt) was released again microseconds later, before the *next* event
/// (the actual letter, sent as a separate DataChannel message) ever arrived.
/// That silently broke every modifier combo (Ctrl+C/V/A, Shift+letter for
/// uppercase) and made holding a key for OS auto-repeat impossible — the root
/// cause behind "keyboard input doesn't work" for anything but a bare
/// lowercase letter. A single instance that outlives every event — with
/// `release_keys_when_dropped: false`, since there's no per-session moment to
/// release keys at — fixes both.
fn with_enigo<R>(f: impl FnOnce(&mut Enigo) -> R) -> Option<R> {
    static ENIGO: OnceLock<Mutex<Enigo>> = OnceLock::new();
    let cell = ENIGO.get_or_init(|| {
        let settings = Settings {
            release_keys_when_dropped: false,
            ..Settings::default()
        };
        // Infallible on Windows: Enigo::new() there never returns Err (no
        // connection/display-server handshake to fail, unlike X11).
        Mutex::new(Enigo::new(&settings).expect("enigo init"))
    });
    cell.lock().ok().map(|mut enigo| f(&mut enigo))
}

/// Apply one input event. Never returns an error the caller must handle: a bad
/// event or a transient injection failure must not tear down the control
/// session, so everything is swallowed (mirroring the try/catch in
/// input-injector.ts).
pub fn inject(event: RcInputEvent) -> Result<(), String> {
    with_enigo(|enigo| apply(enigo, &event));
    Ok(())
}

fn apply(enigo: &mut Enigo, event: &RcInputEvent) {
    // Normalized [0,1] → absolute pixels on the primary display. move_mouse(Abs)
    // re-normalizes by the same metric, so the ratio is DPI-independent.
    let (screen_w, screen_h) = enigo.main_display().unwrap_or((0, 0));
    let px = |n: Option<f64>| -> i32 { (n.unwrap_or(0.0).clamp(0.0, 1.0) * screen_w as f64).round() as i32 };
    let py = |n: Option<f64>| -> i32 { (n.unwrap_or(0.0).clamp(0.0, 1.0) * screen_h as f64).round() as i32 };

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
            let key_str = event.key.as_deref().unwrap_or("");
            if let Some(c) = single_char(key_str) {
                if let Some(key) = ascii_physical_key(c) {
                    dispatch_key(enigo, key, event.action.as_deref(), &modifier_keys(event));
                } else if !matches!(event.action.as_deref(), Some("up")) {
                    // Any other single character (symbols, punctuation, non-Latin
                    // text): type it via enigo.text(), a genuine Unicode
                    // press+release in one call. This sidesteps an enigo 0.2
                    // Windows bug where Key::Unicode fails to inject any
                    // character that needs Shift on the current layout —
                    // VkKeyScanW's shift-state byte leaks unmasked into
                    // MapVirtualKeyW and the lookup silently errors out. There's
                    // nothing to release on the matching "up", since text()
                    // already completed the press+release.
                    let _ = enigo.text(&c.to_string());
                }
                return;
            }
            let Some(key) = map_named_key(key_str) else {
                return;
            };
            dispatch_key(enigo, key, event.action.as_deref(), &modifier_keys(event));
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
}
