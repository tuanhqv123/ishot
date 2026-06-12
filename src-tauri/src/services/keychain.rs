//! API-key storage.
//!
//! Stored in a local file in the app data dir — NOT the macOS Keychain — so the
//! user is never interrupted by a Keychain permission prompt (neither on launch
//! when the Settings panel checks `has_api_key`, nor on first AI chat when the
//! key is read). The value is the user's own OpenAI-compatible API key.
//!
//! Location: `~/Library/Application Support/com.ishot.screenshot/api_key`,
//! perms 0600 (only the logged-in user can read it). It is deliberately NOT in
//! `settings.json` (which can be synced to dotfile repos) and never in the
//! project tree.
//!
//! (Module name kept as `keychain` so callers don't change.)

use std::fs;
use std::path::PathBuf;

const APP_DIR: &str = "com.ishot.screenshot";
const KEY_FILE: &str = "api_key";

fn key_path() -> Option<PathBuf> {
    let mut p = dirs::data_dir()?; // ~/Library/Application Support on macOS
    p.push(APP_DIR);
    let _ = fs::create_dir_all(&p);
    p.push(KEY_FILE);
    Some(p)
}

pub fn set_api_key(key: &str) -> Result<(), String> {
    let path = key_path().ok_or_else(|| "no data dir".to_string())?;
    fs::write(&path, key.trim().as_bytes()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn get_api_key() -> Option<String> {
    let path = key_path()?;
    let s = fs::read_to_string(&path).ok()?;
    let s = s.trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

pub fn has_api_key() -> bool {
    get_api_key().map(|s| !s.is_empty()).unwrap_or(false)
}

pub fn clear_api_key() -> Result<(), String> {
    let Some(path) = key_path() else { return Ok(()) };
    match fs::remove_file(&path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
