//! IPC layer for OS window enumeration. Pure pass-through to
//! `services::window_enum`; lives in its own command file because
//! `commands::window` is reserved for *our* Tauri-window operations
//! (show/hide overlay, etc.) and we don't want to conflate the two domains.

use crate::services::window_enum::{self, WindowInfo};

#[tauri::command]
pub async fn snapshot_windows() -> Result<Vec<WindowInfo>, String> {
    Ok(window_enum::snapshot_windows())
}

#[tauri::command]
pub async fn find_window_at(x: f64, y: f64) -> Result<Option<WindowInfo>, String> {
    Ok(window_enum::find_window_at(x, y))
}
