//! Loom-style screen recording — command layer.
//!
//! This is the wiring + state for the record toolbar (source/mic/camera
//! selection, start/pause/stop). The native capture engine (ScreenCaptureKit +
//! AVFoundation + AVAssetWriter) lands on top of these commands next; for now
//! start/stop/pause manage recording state and broadcast events so the whole
//! UI flow can be built and tested end-to-end.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

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

#[tauri::command]
pub fn start_recording(app: AppHandle, opts: RecordOptions) -> Result<(), String> {
    if RECORDING.load(Ordering::SeqCst) {
        return Err("already recording".into());
    }
    println!(
        "[recorder] start source={} window={:?} monitor={:?} mic={} camera={}",
        opts.source, opts.window_id, opts.monitor, opts.mic, opts.camera
    );
    // Window source → crop to that window's bounds; screen source → full display.
    let crop = if opts.source == "window" {
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
