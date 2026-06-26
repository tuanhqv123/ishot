//! Loom-style screen recording — command layer.
//!
//! This is the wiring + state for the record toolbar (source/mic/camera
//! selection, start/pause/stop). The native capture engine (ScreenCaptureKit +
//! AVFoundation + AVAssetWriter) lands on top of these commands next; for now
//! start/stop/pause manage recording state and broadcast events so the whole
//! UI flow can be built and tested end-to-end.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::services::screen_capture::{MonitorInfo, ScreenCaptureService};
use crate::services::window_enum::{snapshot_windows, WindowInfo};

static RECORDING: AtomicBool = AtomicBool::new(false);
static PAUSED: AtomicBool = AtomicBool::new(false);

/// Displays + windows the user can pick as the recording source. Reuses the
/// same enumeration that powers screenshot capture / scroll capture.
#[derive(Serialize)]
pub struct CaptureTargets {
    pub monitors: Vec<MonitorInfo>,
    pub windows: Vec<WindowInfo>,
}

#[derive(Deserialize)]
pub struct RecordOptions {
    /// "screen" or "window".
    pub source: String,
    /// Window id when `source == "window"`.
    pub window_id: Option<u32>,
    /// Monitor index when `source == "screen"`.
    pub monitor: Option<usize>,
    pub mic: bool,
    pub camera: bool,
    /// Explicit crop rect [x, y, w, h] in global logical points (top-left
    /// origin) — used when recording a selection from the capture overlay.
    pub crop: Option<[f64; 4]>,
}

#[derive(Serialize, Clone)]
pub struct RecordingStatus {
    pub recording: bool,
    pub paused: bool,
}

fn status() -> RecordingStatus {
    RecordingStatus {
        recording: RECORDING.load(Ordering::SeqCst),
        paused: PAUSED.load(Ordering::SeqCst),
    }
}

#[tauri::command]
pub fn list_capture_targets() -> Result<CaptureTargets, String> {
    let monitors = ScreenCaptureService::get_monitors_info().map_err(|e| e.to_string())?;
    let windows = snapshot_windows();
    Ok(CaptureTargets { monitors, windows })
}

#[tauri::command]
pub fn recording_status() -> RecordingStatus {
    status()
}

/// Grow/shrink the record-bar window so its source dropdown can render outside
/// the 68px bar. Done in Rust on the main thread (JS `setSize` proved
/// unreliable for this transparent always-on-top window). The bar is pinned to
/// the window's bottom, so we grow upward and restore on close.
const BAR_W: f64 = 540.0;
const BAR_H: f64 = 68.0;
const MENU_EXTRA: f64 = 264.0;

/// Open (or focus) the floating record controls bar — used after starting a
/// recording from the capture toolbar, so the user gets Stop/Pause/timer.
#[tauri::command]
pub fn open_record_bar(app: AppHandle) {
    crate::open_recorder_window(&app);
}

const CAM_SIZE: f64 = 180.0;

/// Show the circular webcam bubble bottom-right of the active monitor. It's a
/// normal on-screen always-on-top window, so the screen recorder captures it.
#[tauri::command]
pub fn open_camera_bubble(app: AppHandle) {
    if let Some(w) = app.get_webview_window("camera_bubble") {
        let _ = w.show();
        return;
    }
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let (x, y) = match monitor {
        Some(m) => {
            let s = m.scale_factor();
            let mx = m.position().x as f64 / s;
            let my = m.position().y as f64 / s;
            let mw = m.size().width as f64 / s;
            let mh = m.size().height as f64 / s;
            (mx + mw - CAM_SIZE - 28.0, my + mh - CAM_SIZE - 28.0)
        }
        None => (200.0, 200.0),
    };
    let _ = tauri::WebviewWindowBuilder::new(
        &app,
        "camera_bubble",
        tauri::WebviewUrl::App("camera.html".into()),
    )
    .title("Camera")
    .inner_size(CAM_SIZE, CAM_SIZE)
    .position(x, y)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .resizable(false)
    .visible(true)
    .build();
}

#[tauri::command]
pub fn close_camera_bubble(app: AppHandle) {
    if let Some(w) = app.get_webview_window("camera_bubble") {
        let _ = w.close();
    }
}

#[tauri::command]
pub fn set_recorder_expanded(app: AppHandle, expanded: bool) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(w) = app2.get_webview_window("recorder_bar") else {
            return;
        };
        let scale = w.scale_factor().unwrap_or(1.0);
        let extra_px = (MENU_EXTRA * scale) as i32;
        let Ok(pos) = w.outer_position() else { return };
        if expanded {
            let _ = w.set_size(tauri::LogicalSize::<f64>::new(BAR_W, BAR_H + MENU_EXTRA));
            let _ = w.set_position(tauri::PhysicalPosition::<i32>::new(pos.x, pos.y - extra_px));
        } else {
            let _ = w.set_size(tauri::LogicalSize::<f64>::new(BAR_W, BAR_H));
            let _ = w.set_position(tauri::PhysicalPosition::<i32>::new(pos.x, pos.y + extra_px));
        }
    });
}

#[tauri::command]
pub fn start_recording(app: AppHandle, opts: RecordOptions) -> Result<(), String> {
    if RECORDING.load(Ordering::SeqCst) {
        return Err("already recording".into());
    }
    println!(
        "[recorder] start source={} window={:?} monitor={:?} mic={} camera={}",
        opts.source, opts.window_id, opts.monitor, opts.mic, opts.camera
    );
    // Explicit crop (selection from the overlay) wins; else window bounds for a
    // window source; else full display.
    let crop = if let Some(c) = opts.crop {
        Some((c[0], c[1], c[2], c[3]))
    } else if opts.source == "window" {
        opts.window_id.and_then(|id| {
            snapshot_windows()
                .into_iter()
                .find(|w| w.id == id)
                .map(|w| (w.x, w.y, w.w, w.h))
        })
    } else {
        None
    };
    let path = crate::services::recorder::start(opts.mic, crop)?;
    println!("[recorder] recording to {}", path);
    RECORDING.store(true, Ordering::SeqCst);
    PAUSED.store(false, Ordering::SeqCst);
    let _ = app.emit("recording-state", status());
    Ok(())
}

#[tauri::command]
pub fn pause_recording(app: AppHandle) -> Result<(), String> {
    if !RECORDING.load(Ordering::SeqCst) {
        return Err("not recording".into());
    }
    crate::services::recorder::pause();
    PAUSED.store(true, Ordering::SeqCst);
    let _ = app.emit("recording-state", status());
    Ok(())
}

#[tauri::command]
pub fn resume_recording(app: AppHandle) -> Result<(), String> {
    if !RECORDING.load(Ordering::SeqCst) {
        return Err("not recording".into());
    }
    crate::services::recorder::resume();
    PAUSED.store(false, Ordering::SeqCst);
    let _ = app.emit("recording-state", status());
    Ok(())
}

/// Stop recording. Returns the path to the finished clip (None until the
/// capture engine is wired up).
#[tauri::command]
pub fn stop_recording(app: AppHandle) -> Result<Option<String>, String> {
    if !RECORDING.load(Ordering::SeqCst) {
        return Ok(None);
    }
    let path = crate::services::recorder::stop();
    RECORDING.store(false, Ordering::SeqCst);
    PAUSED.store(false, Ordering::SeqCst);
    let _ = app.emit("recording-state", status());
    if let Some(ref p) = path {
        println!("[recorder] stopped, saved {}", p);
        // Surface where it saved (preview+timeline window comes next).
        crate::services::hud::show(&app, &format!("Recording saved → {}", p));
    }
    Ok(path)
}
