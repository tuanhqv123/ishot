//! Appearance-related commands for the screenshot background feature.

/// Return the current desktop wallpaper file path for the main screen.
///
/// Uses `NSWorkspace.sharedWorkspace.desktopImageURLForScreen:` via the ObjC
/// runtime (cocoa/objc are already linked). The frontend loads this path via
/// `convertFileSrc` to use the live wallpaper as a screenshot background.
#[tauri::command]
pub fn get_desktop_wallpaper_path() -> Result<String, String> {
    use cocoa::base::{id, nil};
    use objc::rc::autoreleasepool;
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;
    use std::os::raw::c_char;

    autoreleasepool(|| unsafe {
        let ws: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        if ws == nil {
            return Err("NSWorkspace unavailable".to_string());
        }
        let screen: id = msg_send![class!(NSScreen), mainScreen];
        if screen == nil {
            return Err("No main screen".to_string());
        }
        let url: id = msg_send![ws, desktopImageURLForScreen: screen];
        if url == nil {
            return Err("No desktop image URL".to_string());
        }
        let path: id = msg_send![url, path];
        if path == nil {
            return Err("Desktop image URL has no path".to_string());
        }
        let cstr: *const c_char = msg_send![path, UTF8String];
        if cstr.is_null() {
            return Err("Failed to read wallpaper path".to_string());
        }
        Ok(CStr::from_ptr(cstr).to_string_lossy().into_owned())
    })
}

/// Read an image file and return it as a base64 `data:` URL.
///
/// The background compositor draws this image onto a `<canvas>` and then calls
/// `toDataURL()`. An image loaded via `convertFileSrc` comes from the asset
/// protocol (a different origin) and TAINTS the canvas, so `toDataURL()` throws
/// a SecurityError and the clipboard copy silently fails. A same-origin `data:`
/// URL never taints the canvas — and it also works for files anywhere on disk
/// (no asset-protocol scope needed). Mime is inferred from the extension; the
/// WKWebView decodes png/jpeg/heic/gif/webp/tiff/bmp for display.
#[tauri::command]
pub fn read_image_as_data_url(path: String) -> Result<String, String> {
    use base64::Engine;

    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" | "heif" => "image/heic",
        "tiff" | "tif" => "image/tiff",
        "bmp" => "image/bmp",
        _ => "image/png",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}
