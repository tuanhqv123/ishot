//! Apple Keychain wrapper for the OpenAI-compatible API key.
//!
//! We don't keep the key in `settings.json` because that file can be synced
//! to dotfile repos. Keychain entries are per-user and require the user's
//! login session to read.

use keyring::Entry;

const SERVICE: &str = "com.ishot.screenshot";
const ACCOUNT: &str = "openai-api-key";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
}

pub fn set_api_key(key: &str) -> Result<(), String> {
    let e = entry()?;
    e.set_password(key).map_err(|e| e.to_string())
}

pub fn get_api_key() -> Option<String> {
    let e = entry().ok()?;
    e.get_password().ok()
}

pub fn has_api_key() -> bool {
    get_api_key().map(|s| !s.is_empty()).unwrap_or(false)
}

pub fn clear_api_key() -> Result<(), String> {
    let e = entry()?;
    match e.delete_credential() {
        Ok(_) => Ok(()),
        // If the credential never existed, treat as success.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}
