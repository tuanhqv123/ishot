use tauri::Manager;

/// Show the overlay window for screenshot selection
#[tauri::command]
pub async fn show_overlay(app_handle: tauri::AppHandle) -> Result<(), String> {
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

/// Hide all overlay windows without emitting events.
/// Callers that need to notify frontends should emit "cancel-capture" themselves.
#[tauri::command]
pub async fn hide_overlay(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(overlay) = app_handle.get_webview_window("overlay") {
        let _ = overlay.hide();
    }
    for i in 1..16 {
        let label = format!("overlay_{}", i);
        if let Some(win) = app_handle.get_webview_window(&label) {
            let _ = win.hide();
        }
    }
    Ok(())
}

/// Set whether the overlay window ignores mouse events (passthrough mode).
/// Used during scroll capture so the user can scroll the app behind the overlay.
#[tauri::command]
pub async fn set_overlay_passthrough(app_handle: tauri::AppHandle, ignore: bool) -> Result<(), String> {
    if let Some(overlay) = app_handle.get_webview_window("overlay") {
        overlay.set_ignore_cursor_events(ignore)
            .map_err(|e| format!("Failed to set cursor passthrough: {}", e))?;
    }
    for i in 1..16 {
        let label = format!("overlay_{}", i);
        if let Some(win) = app_handle.get_webview_window(&label) {
            let _ = win.set_ignore_cursor_events(ignore);
        }
    }
    Ok(())
}

/// Show the scroll capture floating panel in the bottom-right corner.
#[tauri::command]
pub async fn show_scroll_panel(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(panel) = app_handle.get_webview_window("scroll_panel") {
        let _ = panel.set_focus();
        return Ok(());
    }

    // Position at bottom-right of primary monitor
    let (x, y) = app_handle.primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let size = m.size();
            let scale = m.scale_factor();
            let w = size.width as f64 / scale;
            let h = size.height as f64 / scale;
            (w - 250.0, h - 360.0)
        })
        .unwrap_or((1450.0, 760.0));

    let _panel = tauri::WebviewWindowBuilder::new(
        &app_handle,
        "scroll_panel",
        tauri::WebviewUrl::App("scroll-panel.html".into()),
    )
    .title("Scroll Capture")
    .inner_size(240.0, 340.0)
    .position(x, y)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .resizable(false)
    .visible(true)
    .focused(true)
    .build()
    .map_err(|e| format!("Failed to create scroll panel: {}", e))?;

    Ok(())
}

/// Hide the scroll capture panel.
#[tauri::command]
pub async fn hide_scroll_panel(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(panel) = app_handle.get_webview_window("scroll_panel") {
        let _ = panel.close();
    }
    Ok(())
}
