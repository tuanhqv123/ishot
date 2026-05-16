use tauri::AppHandle;
use std::path::PathBuf;

/// Save image bytes with file dialog
#[tauri::command]
pub async fn save_to_file(
    image_bytes: Vec<u8>,
    app_handle: AppHandle,
) -> std::result::Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let default_name = format!("ishot_{}.png", timestamp);
    
    let downloads = dirs::download_dir().unwrap_or_else(|| PathBuf::from("."));
    
    let file_path = app_handle
        .dialog()
        .file()
        .set_file_name(&default_name)
        .set_directory(&downloads)
        .add_filter("PNG Image", &["png"])
        .blocking_save_file();
    
    match file_path {
        Some(path) => {
            let path_str = path.to_string();
            std::fs::write(&path_str, &image_bytes)
                .map_err(|e| format!("Failed to save: {}", e))?;
            println!("✅ Saved to: {}", path_str);
            Ok(path_str)
        }
        None => Err("Save cancelled".to_string())
    }
}

/// Copy image bytes to clipboard using arboard crate
#[tauri::command]
pub async fn copy_to_clipboard(
    image_bytes: Vec<u8>,
    _app_handle: AppHandle,
) -> std::result::Result<(), String> {
    use std::time::Instant;
    let start = Instant::now();

    println!("[{:?}] 📋 Copying {} bytes to clipboard...", start.elapsed(), image_bytes.len());

    use arboard::ImageData;
    use std::borrow::Cow;

    println!("[{:?}] 🖼️  Decoding PNG...", start.elapsed());
    let img = image::load_from_memory(&image_bytes)
        .map_err(|e| format!("Failed to decode PNG: {}", e))?;

    println!("[{:?}] ✅ PNG decoded: {}x{}", start.elapsed(), img.width(), img.height());

    let rgba_image = img.to_rgba8();
    let (width, height) = rgba_image.dimensions();
    let bytes = rgba_image.into_raw();

    println!("[{:?}] 📦 RGBA data: {}x{} = {} bytes", start.elapsed(), width, height, bytes.len());

    let image_data = ImageData {
        width: width as usize,
        height: height as usize,
        bytes: Cow::from(bytes),
    };

    println!("[{:?}] 📌 Opening clipboard...", start.elapsed());
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|e| format!("Failed to open clipboard: {}", e))?;

    println!("[{:?}] ✍️  Setting image to clipboard...", start.elapsed());
    clipboard.set_image(image_data)
        .map_err(|e| format!("Failed to set image to clipboard: {}", e))?;

    println!("[{:?}] ✅ Image copied to clipboard! Total: {:?}", start.elapsed(), start.elapsed());
    Ok(())
}

/// Copy text to clipboard
#[tauri::command]
pub async fn copy_text_to_clipboard(
    text: String,
    _app_handle: AppHandle,
) -> std::result::Result<(), String> {
    use arboard::Clipboard;

    let mut clipboard = Clipboard::new()
        .map_err(|e| format!("Failed to open clipboard: {}", e))?;

    clipboard.set_text(text)
        .map_err(|e| format!("Failed to set text to clipboard: {}", e))?;

    Ok(())
}
