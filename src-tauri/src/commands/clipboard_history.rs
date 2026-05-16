// Tauri commands backing the Clipboard History window. The polling service
// owns disk writes; commands here only read, mutate, or replay items back to
// NSPasteboard.

use std::path::Path;

use serde::Serialize;

use crate::services::clipboard_history::{self, CLIPBOARD_DIR};

const TEXT_MAX_CHARS: usize = 50_000;

#[derive(Serialize)]
pub struct HistoryItem {
    pub path: String,
    pub kind: String,
    pub created_at_ms: i64,
    pub size_bytes: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[tauri::command]
pub async fn list_clipboard_history() -> Result<Vec<HistoryItem>, String> {
    let dir = Path::new(CLIPBOARD_DIR);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    let mut items: Vec<HistoryItem> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        // Filename format: "<unix_ms>_<sha12>.<ext>"
        let ts_part = name.split('_').next().unwrap_or("0");
        let created_at_ms: i64 = ts_part.parse().unwrap_or(0);
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let kind = match ext.as_str() {
            "png" => "image",
            "txt" => "text",
            _ => continue,
        };
        let (width, height) = if kind == "image" {
            match image::image_dimensions(&path) {
                Ok((w, h)) => (Some(w), Some(h)),
                Err(_) => (None, None),
            }
        } else {
            (None, None)
        };
        items.push(HistoryItem {
            path: path.to_string_lossy().to_string(),
            kind: kind.to_string(),
            created_at_ms,
            size_bytes: meta.len(),
            width,
            height,
        });
    }
    items.sort_by(|a, b| b.created_at_ms.cmp(&a.created_at_ms));
    items.truncate(200);
    Ok(items)
}

fn validate_path(path: &str) -> Result<(), String> {
    if !path.starts_with(CLIPBOARD_DIR) {
        return Err("path outside clipboard dir".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn read_clipboard_text(path: String) -> Result<String, String> {
    validate_path(&path)?;
    let mut s = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if s.chars().count() > TEXT_MAX_CHARS {
        let truncated: String = s.chars().take(TEXT_MAX_CHARS).collect();
        s = format!("{}…", truncated);
    }
    Ok(s)
}

#[tauri::command]
pub async fn copy_clipboard_item(path: String) -> Result<(), String> {
    validate_path(&path)?;
    let p = Path::new(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext == "txt" {
        let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        clipboard.set_text(text).map_err(|e| e.to_string())?;
        Ok(())
    } else if ext == "png" {
        use arboard::ImageData;
        use std::borrow::Cow;
        let img = image::open(&path).map_err(|e| e.to_string())?.to_rgba8();
        let (w, h) = img.dimensions();
        let data = ImageData {
            width: w as usize,
            height: h as usize,
            bytes: Cow::from(img.into_raw()),
        };
        let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        clipboard.set_image(data).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err(format!("unsupported extension: {}", ext))
    }
}

#[tauri::command]
pub async fn delete_clipboard_item(path: String) -> Result<(), String> {
    validate_path(&path)?;
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_clipboard_history() -> Result<(), String> {
    let dir = Path::new(CLIPBOARD_DIR);
    if !dir.exists() {
        return Ok(());
    }
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let _ = std::fs::remove_file(entry.path());
    }
    Ok(())
}

#[tauri::command]
pub async fn toggle_clipboard_pause() -> Result<bool, String> {
    Ok(clipboard_history::toggle_paused())
}

#[tauri::command]
pub async fn is_clipboard_paused() -> Result<bool, String> {
    Ok(clipboard_history::is_paused())
}
