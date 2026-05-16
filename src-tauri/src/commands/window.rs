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

/// Show the scroll capture floating panel in the bottom-right corner of the
/// monitor the user is currently capturing on.
///
/// `anchor_monitor_x` / `anchor_monitor_y` are the logical-screen origin of
/// that monitor. The panel is positioned at its bottom-right so the user can
/// see it without it overlapping the capture rect.
///
/// Previously this always used `primary_monitor()` — on a multi-monitor setup
/// where the user captures on monitor 2, the panel would silently show up on
/// monitor 1.
#[tauri::command]
pub async fn show_scroll_panel(
    app_handle: tauri::AppHandle,
    anchor_monitor_x: Option<f64>,
    anchor_monitor_y: Option<f64>,
) -> Result<(), String> {
    if let Some(panel) = app_handle.get_webview_window("scroll_panel") {
        let _ = panel.set_focus();
        return Ok(());
    }

    // Find the target monitor. If the frontend passed coordinates, locate the
    // monitor containing them; otherwise fall back to primary.
    let monitors = app_handle.available_monitors().map_err(|e| e.to_string())?;
    let target = if let (Some(mx), Some(my)) = (anchor_monitor_x, anchor_monitor_y) {
        monitors.iter().find(|m| {
            let scale = m.scale_factor();
            let logical_x = m.position().x as f64 / scale;
            let logical_y = m.position().y as f64 / scale;
            let logical_w = m.size().width as f64 / scale;
            let logical_h = m.size().height as f64 / scale;
            mx >= logical_x - 0.5
                && mx < logical_x + logical_w + 0.5
                && my >= logical_y - 0.5
                && my < logical_y + logical_h + 0.5
        }).cloned()
    } else {
        None
    };
    let monitor = target
        .or_else(|| app_handle.primary_monitor().ok().flatten())
        .ok_or_else(|| "no monitor available".to_string())?;

    let scale = monitor.scale_factor();
    let m_x = monitor.position().x as f64 / scale;
    let m_y = monitor.position().y as f64 / scale;
    let m_w = monitor.size().width as f64 / scale;
    let m_h = monitor.size().height as f64 / scale;
    // Panel size: 240×340. Bottom-right corner with 12-px margin.
    // Panel is preview-only now (220×316). Pin to bottom-right of the user's
    // monitor with a 12-px margin.
    let panel_w = 232.0;
    let panel_h = 316.0;
    let x = m_x + m_w - panel_w - 12.0;
    let y = m_y + m_h - panel_h - 12.0;

    let _panel = tauri::WebviewWindowBuilder::new(
        &app_handle,
        "scroll_panel",
        tauri::WebviewUrl::App("scroll-panel.html".into()),
    )
    .title("Scroll Capture")
    .inner_size(panel_w, panel_h)
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

/// Show a fullscreen dim overlay with a transparent "hole" at the selection.
///
/// While the user is scroll-capturing, everything outside the capture rect is
/// dimmed (so the user can see exactly what's being recorded) and a white
/// border outlines the rect. The window is cursor-passthrough so scroll/click
/// events go straight to the underlying app.
///
/// We find the monitor containing the selection and size the dim window to
/// cover that single monitor (not the virtual desktop) — otherwise the window
/// can be larger than any single screen and macOS clamps/positions it oddly.
///
/// `x`/`y`/`width`/`height` are in logical screen coordinates (the same space
/// the frontend gave to `prepare_scroll_capture`).
#[tauri::command]
pub async fn show_scroll_border(
    app_handle: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(existing) = app_handle.get_webview_window("scroll_border") {
        let _ = existing.close();
    }

    // Find the monitor containing the selection center. This makes the dim
    // window cover exactly the screen the user is on, even with multiple monitors.
    let center_x = x + width / 2.0;
    let center_y = y + height / 2.0;
    let monitors = app_handle.available_monitors().map_err(|e| e.to_string())?;
    let monitor = monitors
        .iter()
        .find(|m| {
            let scale = m.scale_factor();
            let mx = m.position().x as f64 / scale;
            let my = m.position().y as f64 / scale;
            let mw = m.size().width as f64 / scale;
            let mh = m.size().height as f64 / scale;
            center_x >= mx && center_x < mx + mw && center_y >= my && center_y < my + mh
        })
        .or_else(|| monitors.first())
        .ok_or_else(|| "no monitor available".to_string())?;

    let scale = monitor.scale_factor();
    let m_x = monitor.position().x as f64 / scale;
    let m_y = monitor.position().y as f64 / scale;
    let m_w = monitor.size().width as f64 / scale;
    let m_h = monitor.size().height as f64 / scale;

    // Coordinates inside the dim window's local space (top-left of the monitor = 0,0).
    let hole_x = x - m_x;
    let hole_y = y - m_y;

    // Pass hole geometry to the HTML via query string. The HTML reads it on load
    // and renders the dim + border via CSS box-shadow trick (cheap, no SVG mask).
    let url = format!(
        "scroll-border.html?x={}&y={}&w={}&h={}",
        hole_x as i32, hole_y as i32, width as i32, height as i32
    );

    let border_window = tauri::WebviewWindowBuilder::new(
        &app_handle,
        "scroll_border",
        tauri::WebviewUrl::App(url.into()),
    )
    .title("")
    .inner_size(m_w, m_h)
    .position(m_x, m_y)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .resizable(false)
    .visible(true)
    .skip_taskbar(true)
    .build()
    .map_err(|e| format!("Failed to create border window: {}", e))?;

    border_window.set_ignore_cursor_events(true)
        .map_err(|e| format!("Failed to set cursor passthrough: {}", e))?;

    Ok(())
}

/// Hide scroll border window.
#[tauri::command]
pub async fn hide_scroll_border(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(border) = app_handle.get_webview_window("scroll_border") {
        let _ = border.close();
    }
    Ok(())
}
