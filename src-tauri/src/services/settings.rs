//! Persistent user settings.
//!
//! Settings live in `~/.config/ishot/settings.json` (Linux/macOS XDG layout —
//! `dirs::config_dir()` on macOS returns `~/Library/Application Support`, but
//! we deliberately keep the simpler `.config/ishot` path used elsewhere in the
//! app for parity with `main.rs::get_config_path`). The struct is loaded once
//! at startup into a `RwLock` so hot readers (clipboard pruning, panel build)
//! don't touch disk on every access.

use std::path::PathBuf;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

/// Modifier bitmask matches the legacy `Config` in `main.rs`:
/// 1 = META (Cmd), 2 = SHIFT, 4 = ALT (Option), 8 = CONTROL.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ShortcutSpec {
    pub modifiers: u32,
    pub key: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Shortcuts {
    pub capture: ShortcutSpec,
    pub clipboard: ShortcutSpec,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AiConfig {
    pub base_url: String,
    pub model: String,
}

/// Screenshot background mode: composite the finished capture onto a
/// background (gradient / solid color / desktop wallpaper / custom image) with
/// adjustable corner radius + padding. Disabled by default.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppearanceConfig {
    pub enabled: bool,
    /// One of: "gradient" | "color" | "wallpaper" | "image".
    pub kind: String,
    /// Gradient id | hex color | custom image path ("" for wallpaper).
    pub value: String,
    pub padding: u32,
    pub radius: u32,
    pub shadow: bool,
}

impl Default for AppearanceConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            kind: "gradient".to_string(),
            value: "".to_string(),
            padding: 48,
            radius: 12,
            shadow: true,
        }
    }
}

/// Loom-style screen recording defaults: which inputs are on and where the
/// camera bubble sits. Persisted so the record toolbar remembers last choices.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RecordingConfig {
    pub mic: bool,
    pub camera: bool,
    /// "screen" (entire display) or "window" (a chosen window).
    pub source: String,
    /// Camera bubble corner: "br" | "bl" | "tr" | "tl".
    pub camera_pos: String,
}

impl Default for RecordingConfig {
    fn default() -> Self {
        Self {
            mic: false,
            camera: false,
            source: "screen".to_string(),
            camera_pos: "br".to_string(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Settings {
    pub shortcuts: Shortcuts,
    pub retention: usize,
    pub ai: AiConfig,
    #[serde(default)]
    pub appearance: AppearanceConfig,
    #[serde(default)]
    pub recording: RecordingConfig,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            shortcuts: Shortcuts {
                capture: ShortcutSpec {
                    modifiers: 1 | 2, // META | SHIFT
                    key: "A".to_string(),
                },
                clipboard: ShortcutSpec {
                    modifiers: 1 | 2, // META | SHIFT
                    key: "V".to_string(),
                },
            },
            retention: 10,
            ai: AiConfig {
                base_url: "https://api.openai.com/v1".to_string(),
                model: "gpt-4o-mini".to_string(),
            },
            appearance: Default::default(),
            recording: Default::default(),
        }
    }
}

fn settings_path() -> PathBuf {
    let dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.join("ishot").join("settings.json")
}

/// Read settings from disk, falling back to defaults on missing file or any
/// parse error. We never panic here — bad JSON should not block app launch.
pub fn load() -> Settings {
    let path = settings_path();
    if !path.exists() {
        return Settings::default();
    }
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save(s: &Settings) -> Result<(), String> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| e.to_string())?;
    Ok(())
}

static CACHE: RwLock<Option<Settings>> = RwLock::new(None);

/// Initialise the in-memory cache from disk. Call once at startup.
pub fn init_cache() {
    let s = load();
    if let Ok(mut guard) = CACHE.write() {
        *guard = Some(s);
    }
}

/// Cheap accessor used by hot paths (e.g. clipboard pruning). Returns a clone
/// of the cached settings — falls back to defaults if the cache hasn't been
/// initialised yet (shouldn't happen in production but keeps tests safe).
pub fn load_cached() -> Settings {
    if let Ok(guard) = CACHE.read() {
        if let Some(s) = guard.as_ref() {
            return s.clone();
        }
    }
    Settings::default()
}

/// Update both disk and cache atomically from the caller's perspective.
pub fn update(new: Settings) -> Result<(), String> {
    save(&new)?;
    if let Ok(mut guard) = CACHE.write() {
        *guard = Some(new);
    }
    Ok(())
}
