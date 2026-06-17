//! Global cursor-position broadcaster for multi-monitor window selection.
//!
//! Each physical monitor has its OWN overlay webview (WKWebView can't span
//! screens). Per-window `mousemove` is unreliable here: a non-key overlay on a
//! secondary monitor doesn't get mouseMoved until clicked, and overlays don't
//! know each other's hover state — so two highlights linger and you must click
//! to "wake" the other screen.
//!
//! Fix: poll the GLOBAL cursor position in Rust (works regardless of which
//! window is key) and broadcast it to every overlay. Each overlay then decides
//! locally: cursor on MY monitor → hit-test + highlight; otherwise → clear.
//! One highlight, follows the cursor across monitors, no click needed.
//!
//! `CGEvent::location()` returns global LOGICAL points with a top-left origin —
//! exactly the coordinate space the frontend's monitor bounds + window list use.

use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use core_graphics::event::CGEvent;
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use tauri::{AppHandle, Emitter};

static ACTIVE: AtomicBool = AtomicBool::new(false);

/// Begin broadcasting `cursor-pos` ([x, y] logical, top-left) at ~60fps. No-op
/// if already running.
pub fn start(app: AppHandle) {
    if ACTIVE.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::spawn(move || {
        while ACTIVE.load(Ordering::SeqCst) {
            if let Ok(src) = CGEventSource::new(CGEventSourceStateID::CombinedSessionState) {
                if let Ok(ev) = CGEvent::new(src) {
                    let p = ev.location();
                    let _ = app.emit("cursor-pos", (p.x, p.y));
                }
            }
            thread::sleep(Duration::from_millis(16));
        }
    });
}

/// Stop broadcasting (the thread exits within one poll interval).
pub fn stop() {
    ACTIVE.store(false, Ordering::SeqCst);
}
