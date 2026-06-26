use tauri::{AppHandle, Manager};
use std::path::PathBuf;

/// Activate the app so a native panel comes to the front (iShot is a
/// non-activating menu-bar app, so dialogs would otherwise open buried).
fn activate_app() {
    unsafe {
        use cocoa::base::{id, YES};
        use objc::{class, msg_send, sel, sel_impl};
        let ns_app: id = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![ns_app, activateIgnoringOtherApps: YES];
    }
}

/// Save image bytes (PNG, passed as the invoke RAW body) with a file dialog.
#[tauri::command]
pub async fn save_to_file(
    app_handle: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> std::result::Result<String, String> {
    use tauri_plugin_dialog::DialogExt;

    let image_bytes: Vec<u8> = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        _ => return Err("save_to_file expects raw PNG bytes".into()),
    };

    // The capture overlay is an always-on-top panel, so an NSSavePanel opens
    // BEHIND it and the main thread blocks on the modal → the app looks frozen.
    // Hide the overlay windows first; restore them if the user cancels so their
    // annotations aren't lost.
    let overlays: Vec<tauri::WebviewWindow> = app_handle
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label == "overlay" || label.starts_with("overlay_"))
        .map(|(_, w)| w)
        .collect();
    for w in &overlays {
        let _ = w.hide();
    }
    let app2 = app_handle.clone();
    let _ = app_handle.run_on_main_thread(move || {
        activate_app();
        let _ = &app2;
    });

    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let id = format!(
        "{:08x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0)
    );
    let default_name = format!("screenshot_{}_{}.png", timestamp, id);

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
        None => {
            // Cancelled → bring the overlays back so the user keeps annotating.
            for w in &overlays {
                let _ = w.show();
            }
            Err("Save cancelled".to_string())
        }
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

/// Copy a raw RGBA image straight to the clipboard — NO PNG encode/decode.
///
/// The JS side renders to a canvas and sends `[width u32 LE][height u32 LE][RGBA…]`
/// as the invoke raw body (Tauri v2 transfers Uint8Array as binary). This skips
/// the JS PNG encode AND the Rust PNG decode (which was ~600ms for big images).
#[tauri::command]
pub async fn copy_image_rgba(
    request: tauri::ipc::Request<'_>,
) -> std::result::Result<(), String> {
    use arboard::ImageData;
    use std::borrow::Cow;

    let body: &[u8] = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.as_slice(),
        _ => return Err("copy_image_rgba expects raw bytes".into()),
    };
    if body.len() < 8 {
        return Err("payload too short".into());
    }
    let width = u32::from_le_bytes([body[0], body[1], body[2], body[3]]) as usize;
    let height = u32::from_le_bytes([body[4], body[5], body[6], body[7]]) as usize;
    let rgba = &body[8..];
    if rgba.len() != width * height * 4 {
        return Err(format!(
            "rgba size mismatch: {} != {}",
            rgba.len(),
            width * height * 4
        ));
    }
    let image_data = ImageData {
        width,
        height,
        bytes: Cow::Borrowed(rgba),
    };
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|e| format!("Failed to open clipboard: {}", e))?;
    clipboard
        .set_image(image_data)
        .map_err(|e| format!("Failed to set image to clipboard: {}", e))?;
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
