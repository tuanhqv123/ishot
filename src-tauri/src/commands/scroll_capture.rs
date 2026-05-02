use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use crate::services::scroll_capture::{ScrollCaptureService, ScrollCaptureState, ScrollCaptureResult};

/// Prepare scroll capture: store the selection rect so the scroll panel can start later
#[tauri::command]
pub async fn prepare_scroll_capture(
    state: State<'_, Arc<Mutex<ScrollCaptureState>>>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> std::result::Result<(), String> {
    println!("[scroll] prepare_scroll_capture: x={}, y={}, w={}, h={}", x, y, width, height);
    let mut s = state.lock().unwrap();
    s.selection_rect = Some((x, y, width, height));
    println!("[scroll] prepare_scroll_capture: done");
    Ok(())
}

/// Start scroll capture (called by scroll panel when user clicks Start)
#[tauri::command]
pub async fn start_scroll_capture(
    app: AppHandle,
    state: State<'_, Arc<Mutex<ScrollCaptureState>>>,
) -> std::result::Result<(), String> {
    let rect = {
        let s = state.lock().unwrap();
        s.selection_rect.ok_or("No selection rect prepared")?
    };
    let state_clone = state.inner().clone();
    let app_emit = app.clone();

    // Spawn capture in background thread
    std::thread::spawn(move || {
        match ScrollCaptureService::start_capture(state_clone, rect, app_emit.clone()) {
            Ok(Some((data, w, h))) => {
                let _ = app_emit.emit("scroll-capture-result", ScrollCaptureResult {
                    data,
                    width: w,
                    height: h,
                });
            }
            Ok(None) => {
                // Cancelled or stopped - handled by separate command
            }
            Err(e) => {
                eprintln!("[scroll] capture error: {}", e);
                let _ = app_emit.emit("scroll-capture-error", e.to_string());
            }
        }
    });

    Ok(())
}

/// Stop scroll capture and return result
#[tauri::command]
pub async fn stop_scroll_capture(
    state: State<'_, Arc<Mutex<ScrollCaptureState>>>,
) -> std::result::Result<Option<ScrollCaptureResult>, String> {
    ScrollCaptureService::stop_capture(state.inner().clone())
        .map_err(|e| e.to_string())
}

/// Cancel scroll capture without saving
#[tauri::command]
pub async fn cancel_scroll_capture(
    state: State<'_, Arc<Mutex<ScrollCaptureState>>>,
) -> std::result::Result<(), String> {
    ScrollCaptureService::cancel_capture(state.inner().clone());
    Ok(())
}

/// Get current scroll capture state
#[tauri::command]
pub async fn get_scroll_capture_state(
    state: State<'_, Arc<Mutex<ScrollCaptureState>>>,
) -> std::result::Result<bool, String> {
    let s = state.lock().unwrap();
    Ok(s.is_capturing)
}
