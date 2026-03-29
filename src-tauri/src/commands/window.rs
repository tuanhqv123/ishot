use tauri::{AppHandle, Emitter, Manager};

/// Show the overlay window for screenshot selection
#[tauri::command]
pub async fn show_overlay(app_handle: AppHandle) -> Result<(), String> {
    if let Some(overlay) = app_handle.get_webview_window("overlay") {
        overlay.set_ignore_cursor_events(false)
            .map_err(|e| format!("Failed to enable cursor events: {}", e))?;
        overlay.show()
            .map_err(|e| format!("Failed to show overlay: {}", e))?;
        overlay.set_focus()
            .map_err(|e| format!("Failed to focus overlay: {}", e))?;
        Ok(())
    } else {
        Err("Overlay window not found".to_string())
    }
}

/// Hide all overlay windows — emits "cancel-capture" so all frontends reset
#[tauri::command]
pub async fn hide_overlay(app_handle: AppHandle) -> Result<(), String> {
    // Tell all frontends to reset state
    let _ = app_handle.emit("cancel-capture", ());

    if let Some(overlay) = app_handle.get_webview_window("overlay") {
        let _ = overlay.hide();
    }
    // Hide secondary overlay windows (don't close — reuse on next trigger)
    for i in 1..16 {
        let label = format!("overlay_{}", i);
        if let Some(win) = app_handle.get_webview_window(&label) {
            let _ = win.hide();
        }
    }
    Ok(())
}
