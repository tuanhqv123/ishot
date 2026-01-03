use tauri::{AppHandle, Manager};

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

/// Hide the overlay window
#[tauri::command]
pub async fn hide_overlay(app_handle: AppHandle) -> Result<(), String> {
    if let Some(overlay) = app_handle.get_webview_window("overlay") {
        overlay.hide()
            .map_err(|e| format!("Failed to hide overlay: {}", e))?;
        Ok(())
    } else {
        Err("Overlay window not found".to_string())
    }
}
