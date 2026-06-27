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

/// macOS product version (e.g. "15.2") — included in bug-report emails.
#[tauri::command]
pub fn get_os_version() -> String {
    std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Check the update endpoint; returns Some(version) if a newer signed build is
/// available, None if up to date. Used by Settings to show an inline "Update"
/// button.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(u)) => Ok(Some(u.version)),
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Download + install the available update (signature-verified), then restart.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    if let Some(update) = updater.check().await.map_err(|e| e.to_string())? {
        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|e| e.to_string())?;
        app.restart();
    }
    Ok(())
}

/// Whether "launch at login" is currently enabled. Uses SMAppService
/// (macOS 13+), which registers the APP itself as the login item — so macOS
/// shows "iShot" in Login Items / background notifications, not the
/// Developer-ID team name a raw LaunchAgent would surface.
#[tauri::command]
pub fn get_autostart(_app: AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        sm_autostart::is_enabled()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Enable/disable "launch at login" via SMAppService. Also removes any legacy
/// LaunchAgent left by older builds (that one displayed the team name), so the
/// switch-over is clean with no leftover background item.
#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    // Best-effort: drop the old LaunchAgent plist if a previous version created
    // one. Ignored if absent.
    {
        use tauri_plugin_autostart::ManagerExt;
        let _ = app.autolaunch().disable();
    }
    #[cfg(target_os = "macos")]
    {
        sm_autostart::set(enabled)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = enabled;
        Ok(())
    }
}

/// Native SMAppService.mainApp bridge (macOS 13+). Looked up at runtime via
/// `Class::get` so older systems return gracefully instead of panicking.
#[cfg(target_os = "macos")]
mod sm_autostart {
    use cocoa::base::{id, nil, BOOL, YES};
    use objc::runtime::Class;
    use objc::{msg_send, sel, sel_impl};

    // SMAppServiceStatus: 0 NotRegistered · 1 Enabled · 2 RequiresApproval · 3 NotFound
    pub fn is_enabled() -> bool {
        let Some(cls) = Class::get("SMAppService") else {
            return false;
        };
        unsafe {
            let svc: id = msg_send![cls, mainAppService];
            if svc == nil {
                return false;
            }
            let status: i64 = msg_send![svc, status];
            status == 1
        }
    }

    pub fn set(enabled: bool) -> Result<(), String> {
        let Some(cls) = Class::get("SMAppService") else {
            return Err("Launch at login needs macOS 13 or later".to_string());
        };
        unsafe {
            let svc: id = msg_send![cls, mainAppService];
            if svc == nil {
                return Err("SMAppService unavailable".to_string());
            }
            let mut err: id = nil;
            let ok: BOOL = if enabled {
                msg_send![svc, registerAndReturnError: &mut err]
            } else {
                msg_send![svc, unregisterAndReturnError: &mut err]
            };
            if ok == YES {
                Ok(())
            } else {
                let msg = if err != nil {
                    let desc: id = msg_send![err, localizedDescription];
                    nsstring_to_string(desc)
                } else {
                    "Could not update login item".to_string()
                };
                Err(msg)
            }
        }
    }

    unsafe fn nsstring_to_string(s: id) -> String {
        if s == nil {
            return String::new();
        }
        let bytes: *const std::os::raw::c_char = msg_send![s, UTF8String];
        if bytes.is_null() {
            return String::new();
        }
        std::ffi::CStr::from_ptr(bytes)
            .to_string_lossy()
            .into_owned()
    }
}
