//! Tauri commands backing the settings panel.
//!
//! Persistence flow: the panel sends a full `Settings` struct via
//! `save_settings`. We write it to disk + cache, re-register the global
//! shortcuts, then broadcast `settings-changed` so any other window can
//! react (e.g. show the updated shortcut hint in the menu).

use tauri::{AppHandle, Emitter};

use crate::services::{keychain, settings, settings_panel};

/// Open the Settings panel (build if needed). Called e.g. when the user tries
/// AI chat without an API key — we send them straight here.
///
/// NSPanel build/show MUST happen on the main (UI) thread. This command is
/// `async`, so it runs on a tokio worker thread — calling AppKit from there
/// crashes the app. Hop to the main thread before touching the panel.
#[tauri::command]
pub async fn open_settings(app: AppHandle) -> Result<(), String> {
    let app2 = app.clone();
    app.run_on_main_thread(move || settings_panel::show(&app2))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_settings() -> settings::Settings {
    settings::load_cached()
}

#[tauri::command]
pub async fn save_settings(
    settings: settings::Settings,
    app: AppHandle,
) -> Result<(), String> {
    settings::update(settings.clone())?;
    crate::re_register_shortcuts(&app);
    let _ = app.emit("settings-changed", &settings);
    Ok(())
}

#[tauri::command]
pub async fn has_api_key() -> bool {
    keychain::has_api_key()
}

#[tauri::command]
pub async fn set_api_key(key: String) -> Result<(), String> {
    keychain::set_api_key(&key)
}

#[tauri::command]
pub async fn clear_api_key() -> Result<(), String> {
    keychain::clear_api_key()
}

/// Current app version (from Cargo.toml), shown in the Settings footer.
#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Whether "launch at login" (autostart LaunchAgent) is currently enabled.
#[tauri::command]
pub fn get_autostart(app: AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// Enable/disable "launch at login". Moved out of the tray menu into Settings.
#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let al = app.autolaunch();
    if enabled {
        al.enable().map_err(|e| e.to_string())
    } else {
        al.disable().map_err(|e| e.to_string())
    }
}
