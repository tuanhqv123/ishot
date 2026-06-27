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
    /// Small cached thumbnail path for fast list rendering (images only).
    pub thumb: Option<String>,
}

/// Cached thumbnail path: `<dir>/thumbs/<name>.jpg`. NON-hidden dir on purpose —
/// the asset-protocol glob (`/tmp/ishot_*/**`) doesn't match dot-prefixed paths.
fn thumb_path_for(image: &Path) -> Option<std::path::PathBuf> {
    let name = image.file_name()?.to_str()?;
    Some(
        Path::new(CLIPBOARD_DIR)
            .join("thumbs")
            .join(format!("{name}.jpg")),
    )
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
        // Use a cached thumbnail if it already exists (fast list render).
        let thumb = if kind == "image" {
            thumb_path_for(&path)
                .filter(|t| t.exists())
                .map(|t| t.to_string_lossy().to_string())
        } else {
            None
        };
        items.push(HistoryItem {
            path: path.to_string_lossy().to_string(),
            kind: kind.to_string(),
            created_at_ms,
            size_bytes: meta.len(),
            width,
            height,
            thumb,
        });
    }
    items.sort_by(|a, b| b.created_at_ms.cmp(&a.created_at_ms));
    items.truncate(200);

    // Generate any MISSING thumbnails in the background so this call returns
    // immediately; they appear on the next refresh (~2s). Decoding full-res
    // PNGs to render the list directly was the cause of the slow open.
    let missing: Vec<String> = items
        .iter()
        .filter(|it| it.kind == "image" && it.thumb.is_none())
        .map(|it| it.path.clone())
        .collect();
    if !missing.is_empty() {
        std::thread::spawn(move || {
            let _ = std::fs::create_dir_all(Path::new(CLIPBOARD_DIR).join("thumbs"));
            for p in missing {
                let src = Path::new(&p);
                let Some(dst) = thumb_path_for(src) else { continue };
                if dst.exists() {
                    continue;
                }
                if let Ok(img) = image::open(src) {
                    // Longest side ~1200px: the panel is 640pt wide, so on a 2×
                    // Retina display the list image needs ~1184px to stay crisp.
                    // Big enough that the thumb never renders smaller than the full
                    // image (no "flash big then shrink"), still fast to decode.
                    let thumb = img.thumbnail(1200, 1200);
                    let _ = thumb.to_rgb8().save(&dst);
                }
            }
        });
    }

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
