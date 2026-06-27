//! "Pin to screen" — float the captured region as a borderless, always-on-top
//! window the user can park anywhere (e.g. beside other files for data entry /
//! comparison). The frontend renders the selection to a PNG and sends it here
//! as a raw payload: [logical_w u32 LE][logical_h u32 LE][PNG bytes…]. We drop
//! the PNG to a temp file and open a window that displays it.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Largest pinned window we'll open; bigger captures are scaled down to fit
/// (keeping aspect) so a full-screen grab doesn't open a giant window.
const MAX_W: f64 = 1100.0;
const MAX_H: f64 = 800.0;

#[tauri::command]
pub async fn pin_image(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let body: Vec<u8> = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        _ => return Err("pin_image expects raw bytes".into()),
    };
    if body.len() < 8 {
        return Err("pin_image payload too small".into());
    }
    let w = u32::from_le_bytes([body[0], body[1], body[2], body[3]]);
    let h = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
    let png = &body[8..];
    if w == 0 || h == 0 || png.is_empty() {
        return Err("pin_image got an empty image".into());
    }

    let id = format!(
        "{:08x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0)
    );
    // MUST live under /tmp/ishot_* — that's the assetProtocol scope the pin
    // window's <img> loads through (std::env::temp_dir() is /var/folders/… on
    // macOS, which is NOT in scope, so the image would silently fail to load).
    let path = std::path::PathBuf::from("/tmp").join(format!("ishot_pin_{}.png", id));
    std::fs::write(&path, png).map_err(|e| e.to_string())?;

    // Fit the window to the image, scaled down if it exceeds the cap.
    let (iw, ih) = (w as f64, h as f64);
    let scale = (MAX_W / iw).min(MAX_H / ih).min(1.0);
    let (win_w, win_h) = (iw * scale, ih * scale);

    // Cascade new pins so they don't stack exactly on top of each other.
    let existing = app
        .webview_windows()
        .keys()
        .filter(|l| l.starts_with("pin_"))
        .count();
    let off = (existing as f64) * 28.0;

    let label = format!("pin_{}", id);
    let url = format!(
        "pin.html?path={}&w={}&h={}",
        urlencoding(&path.to_string_lossy()),
        w,
        h
    );

    let app2 = app.clone();
    app.run_on_main_thread(move || {
        let built = WebviewWindowBuilder::new(&app2, &label, WebviewUrl::App(url.into()))
            .title("Pinned")
            .inner_size(win_w, win_h)
            .min_inner_size(80.0, 60.0)
            .position(140.0 + off, 120.0 + off)
            .decorations(false)
            .transparent(true)
            .resizable(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(true)
            .build();
        if let Err(e) = built {
            eprintln!("[pin] window build failed: {e}");
        }
    })
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Minimal percent-encoding for a file path placed in a query string (spaces,
/// non-ASCII, and the handful of reserved chars that would break parsing).
fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}
