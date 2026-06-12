use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};
use crate::services::accessibility::check_accessibility;
use crate::services::scroll_capture::{
    AutoScrollConfig, ScrollCaptureService, ScrollCaptureState, ScrollCaptureResult,
};

/// Esc must work GLOBALLY while a scroll capture runs: the user scrolls (and
/// often clicks into) the target window, which takes focus away from the scroll
/// panel — its webview `keydown` listener then never fires and the session
/// can't be finished. A global shortcut catches Esc regardless of focus; the
/// handler just emits `scroll-esc` and the panel runs its normal finish flow.
fn esc_shortcut() -> Shortcut {
    Shortcut::new(None, Code::Escape)
}

pub fn register_scroll_esc(app: &AppHandle) {
    let app2 = app.clone();
    if let Err(e) = app
        .global_shortcut()
        .on_shortcut(esc_shortcut(), move |_app, _sc, event| {
            if event.state == ShortcutState::Pressed {
                let _ = app2.emit("scroll-esc", ());
            }
        })
    {
        eprintln!("[scroll] esc shortcut register failed: {}", e);
    }
}

pub fn unregister_scroll_esc(app: &AppHandle) {
    let _ = app.global_shortcut().unregister(esc_shortcut());
}

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
    register_scroll_esc(&app);

    // Spawn capture in background thread
    std::thread::spawn(move || {
        match ScrollCaptureService::start_capture(state_clone, rect, app_emit.clone()) {
            Ok(Some((_data, _w, _h))) => {
                // Result already emitted by finalize() — nothing to do here
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

/// Start auto-scroll capture (Shottr-style): app dispatches scroll events itself,
/// pastes at known offsets — no NCC, no ambiguity, no duplicated content.
///
/// `cursor_anchor_x` / `cursor_anchor_y` are LOGICAL screen coordinates where
/// the cursor must sit for scroll events to land in the right window
/// (typically the center of the selection rect). The frontend computes these
/// from the selection's logical position.
#[tauri::command]
pub async fn start_auto_scroll_capture(
    app: AppHandle,
    state: State<'_, Arc<Mutex<ScrollCaptureState>>>,
    cursor_anchor_x: f64,
    cursor_anchor_y: f64,
    speed_pps: Option<u32>,
    max_height: Option<u32>,
) -> std::result::Result<(), String> {
    let rect = {
        let s = state.lock().unwrap();
        s.selection_rect.ok_or("No selection rect prepared")?
    };

    // Auto-scroll dispatches CGScrollEvents to drive the focused window's
    // scrollbar. macOS gates that capability behind the Accessibility
    // permission — without it, the post calls silently no-op and the user
    // sees a frozen panel. Prompt now so the OS surfaces its consent
    // dialog AND registers the app in Privacy & Security on first use.
    if !check_accessibility(true) {
        return Err("accessibility-required".into());
    }

    let config = AutoScrollConfig {
        speed_pps: speed_pps.unwrap_or(600).max(50).min(2000),
        max_height: max_height.unwrap_or(20_000).max(1_000).min(200_000),
    };
    let state_clone = state.inner().clone();
    let app_emit = app.clone();
    register_scroll_esc(&app);

    std::thread::spawn(move || {
        match ScrollCaptureService::start_auto_capture(
            state_clone,
            rect,
            (cursor_anchor_x, cursor_anchor_y),
            config,
            app_emit.clone(),
        ) {
            Ok(_) => {}
            Err(e) => {
                eprintln!("[auto-scroll] error: {}", e);
                let _ = app_emit.emit("scroll-capture-error", e.to_string());
            }
        }
    });

    Ok(())
}

/// Stop scroll capture and return result
#[tauri::command]
pub async fn stop_scroll_capture(
    app: AppHandle,
    state: State<'_, Arc<Mutex<ScrollCaptureState>>>,
) -> std::result::Result<Option<ScrollCaptureResult>, String> {
    unregister_scroll_esc(&app);
    ScrollCaptureService::stop_capture(state.inner().clone())
        .map_err(|e| e.to_string())
}

/// Result of finalize_scroll_to_clipboard. Just dimensions — the actual image
/// is already on the clipboard, no need to send the bytes back to the frontend.
#[derive(serde::Serialize)]
pub struct ScrollFinalizeResult {
    pub width: u32,
    pub height: u32,
}

/// Stop scroll capture AND copy the result straight to the clipboard from Rust,
/// without any PNG round-trip through the frontend.
///
/// Why this exists: the previous flow was
///   1. Rust encodes RGBA → PNG  (slow for tall stitches)
///   2. IPC sends PNG bytes to JS  (slow for big payloads)
///   3. JS sends them right back via copy_to_clipboard
///   4. Rust decodes PNG → RGBA  (slow again)
///   5. Rust writes RGBA to clipboard
///
/// For a 1410×4188 stitch (5.9 MP / 24 MB RGBA / 5 MB PNG) that round-trip
/// cost ~700 ms. This command keeps the RGBA in Rust the entire time —
/// just locks state, takes the image, sets it on the clipboard. ~15-30 ms.
#[tauri::command]
pub async fn finalize_scroll_to_clipboard(
    app: AppHandle,
    state: State<'_, Arc<Mutex<ScrollCaptureState>>>,
) -> std::result::Result<Option<ScrollFinalizeResult>, String> {
    use std::borrow::Cow;
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};

    unregister_scroll_esc(&app);
    let t0 = Instant::now();

    // Step 1: signal the capture loop to stop AND claim the externally-
    // finalized flag so its own `finalize` path skips re-copying to clipboard.
    {
        let s = state.lock().unwrap();
        s.should_stop.store(true, Ordering::SeqCst);
        s.externally_finalized.store(true, Ordering::SeqCst);
    }

    // Step 2: wait briefly for the capture thread to land its in-flight step
    // and the final state sync. Without this, we'd grab the state image as it
    // was at the LAST sync_progress, which can lag by one step (= one divider-
    // worth of content missing from the output the user just pasted).
    //
    // The capture loop's final sync happens AFTER it exits the inner loop.
    // We poll until `is_capturing` flips (the loop's stop handler syncs the
    // final image first). Deadline must outlast the manual-capture idle sleep
    // (250 ms) plus one capture+NCC cycle, or we'd grab a stale image.
    let deadline = Instant::now() + Duration::from_millis(600);
    while Instant::now() < deadline {
        if !state.lock().unwrap().is_capturing {
            break;
        }
        std::thread::sleep(Duration::from_millis(15));
    }

    // Step 3: take the (now-final) stitched image and copy.
    let stitched = state.lock().unwrap().stitched_image.take();

    let Some(img) = stitched else { return Ok(None) };
    let (width, height) = img.dimensions();
    let raw: Vec<u8> = img.into_raw();
    let t_extract = t0.elapsed();

    let image_data = arboard::ImageData {
        width: width as usize,
        height: height as usize,
        bytes: Cow::from(raw),
    };

    let mut clipboard = arboard::Clipboard::new()
        .map_err(|e| format!("clipboard open: {}", e))?;
    clipboard.set_image(image_data)
        .map_err(|e| format!("clipboard set: {}", e))?;

    println!(
        "[scroll] finalize_scroll_to_clipboard: {}×{} done in {:?} (extract {:?})",
        width, height, t0.elapsed(), t_extract
    );

    // Confirmation as the in-app HUD pill, not a Notification Center banner.
    crate::services::hud::show(
        &app,
        &format!("Saved {}×{} — copied to clipboard", width, height),
    );

    Ok(Some(ScrollFinalizeResult { width, height }))
}

/// Cancel scroll capture without saving
#[tauri::command]
pub async fn cancel_scroll_capture(
    app: AppHandle,
    state: State<'_, Arc<Mutex<ScrollCaptureState>>>,
) -> std::result::Result<(), String> {
    unregister_scroll_esc(&app);
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
