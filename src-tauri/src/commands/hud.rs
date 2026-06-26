//! HUD command — expose the bottom-center frosted pill to webviews.

/// Show a transient HUD pill with `text`. `ms` overrides the visible duration
/// (defaults to 1950ms, matching `services::hud`'s default).
#[tauri::command]
pub fn show_hud(app: tauri::AppHandle, text: String, ms: Option<u64>) {
    crate::services::hud::show_for(&app, &text, ms.unwrap_or(1950));
}
