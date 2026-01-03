use crate::services::screen_capture::ScreenCaptureService;

#[derive(serde::Serialize)]
pub struct ScreenshotResult {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Capture the entire main display including menu bar
#[tauri::command]
pub async fn capture_screen() -> std::result::Result<ScreenshotResult, String> {
    let start = std::time::Instant::now();
    let (data, width, height) = ScreenCaptureService::capture_main_display()
        .map_err(|e: crate::error::AppError| e.to_string())?;
    println!("Captured {}x{} in {:?}", width, height, start.elapsed());
    Ok(ScreenshotResult { data, width, height })
}

/// Capture a specific region of the display
#[tauri::command]
pub async fn capture_region(
    _x: f64,
    _y: f64,
    _width: f64,
    _height: f64,
) -> std::result::Result<Vec<u8>, String> {
    Err("Not implemented".to_string())
}

/// Get the bounds of the main display
#[tauri::command]
pub async fn get_display_bounds() -> std::result::Result<(f64, f64, f64, f64), String> {
    ScreenCaptureService::get_display_bounds()
        .map_err(|e: crate::error::AppError| e.to_string())
}
