//! Tauri commands backing the settings panel.
//!
//! Persistence flow: the panel sends a full `Settings` struct via
//! `save_settings`. We write it to disk + cache, re-register the global
//! shortcuts, then broadcast `settings-changed` so any other window can
//! react (e.g. show the updated shortcut hint in the menu).

use tauri::{AppHandle, Emitter};

use crate::services::{keychain, settings};

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
