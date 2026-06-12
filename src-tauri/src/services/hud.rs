//! In-app HUD pill — the replacement for macOS Notification banners on
//! routine confirmations (stitch saved, update installed, …).
//!
//! Why not `Notification`: banners pop at the screen's top-right corner, pile
//! up in Notification Center, and need the notification permission. A CleanShot-
//! style frosted pill near the bottom-center of the active monitor reads as
//! part of the app, disappears on its own, and needs nothing from the user.
//!
//! The pill is a tiny transparent always-on-top webview (`hud.html`) that
//! ignores the cursor; Rust tears it down ~2s later. A generation counter
//! makes sure a newer HUD isn't killed by an older HUD's closer thread.

use std::sync::atomic::{AtomicU64, Ordering};

use tauri::Manager;

static GENERATION: AtomicU64 = AtomicU64::new(0);

const HUD_W: f64 = 460.0;
const HUD_H: f64 = 76.0;
const HUD_VISIBLE_MS: u64 = 1950;

/// Percent-encode for a URL query value (RFC 3986 unreserved kept verbatim).
fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 3);
    for b in text.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Show a transient HUD pill with `text` near the bottom-center of the monitor
/// the cursor is on. Safe to call from any thread.
pub fn show(app: &tauri::AppHandle, text: &str) {
    show_for(app, text, HUD_VISIBLE_MS);
}

/// Like [`show`], with a custom visible duration — for messages that take
/// longer to read (e.g. permission guidance).
pub fn show_for(app: &tauri::AppHandle, text: &str, visible_ms: u64) {
    let gen = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let app2 = app.clone();
    let url = format!("hud.html?text={}&ms={}", encode(text), visible_ms);

    // Window creation is AppKit — main thread only.
    let app_main = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = app_main.get_webview_window("hud") {
            let _ = w.close();
        }

        // Monitor under the cursor; fall back to primary.
        let monitor = app_main
            .cursor_position()
            .ok()
            .and_then(|p| app_main.monitor_from_point(p.x, p.y).ok().flatten())
            .or_else(|| app_main.primary_monitor().ok().flatten());
        let Some(m) = monitor else { return };
        let scale = m.scale_factor();
        let mx = m.position().x as f64 / scale;
        let my = m.position().y as f64 / scale;
        let mw = m.size().width as f64 / scale;
        let mh = m.size().height as f64 / scale;
        let x = mx + (mw - HUD_W) / 2.0;
        let y = my + mh - HUD_H - mh * 0.07; // ~7% above the bottom edge

        let built = tauri::WebviewWindowBuilder::new(
            &app_main,
            "hud",
            tauri::WebviewUrl::App(url.into()),
        )
        .inner_size(HUD_W, HUD_H)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .resizable(false)
        .focused(false)
        .accept_first_mouse(false)
        .visible(true)
        .build();

        if let Ok(w) = built {
            // Pure display — clicks pass through to whatever's underneath.
            let _ = w.set_ignore_cursor_events(true);
        }
    });

    // Tear-down after the pill has faded. Only close if no newer HUD took over.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(HUD_VISIBLE_MS));
        if GENERATION.load(Ordering::SeqCst) != gen {
            return;
        }
        let app3 = app2.clone();
        let _ = app2.run_on_main_thread(move || {
            if let Some(w) = app3.get_webview_window("hud") {
                let _ = w.close();
            }
        });
    });
}
