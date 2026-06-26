//! Appearance-related commands for the screenshot background feature.

/// Open a native image file picker for the screenshot background and return the
/// chosen absolute path (`None` if the user cancels).
///
/// Driven from Rust (not the JS dialog plugin): the Settings panel hides itself
/// when it loses key focus (the picker steals it), which is the behaviour we
/// want — the panel disappears while picking. We activate the app first so the
/// NSOpenPanel comes to the front (iShot is a non-activating menu-bar app), and
/// re-show Settings afterwards so the user sees the result.
#[tauri::command]
pub async fn pick_background_image(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    // Activate the app so the picker isn't buried behind other windows.
    let _ = app.run_on_main_thread(|| unsafe {
        use cocoa::base::{id, YES};
        use objc::{class, msg_send, sel, sel_impl};
        let ns_app: id = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![ns_app, activateIgnoringOtherApps: YES];
    });

    let picked = app
        .dialog()
        .file()
        .add_filter(
            "Images",
            &[
                "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tiff", "tif", "bmp",
            ],
        )
        .blocking_pick_file();

    // Bring Settings back so the user sees the applied background + preview.
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        crate::services::settings_panel::show(&app2);
    });

    Ok(picked.map(|p| p.to_string()))
}

/// Return a file path to the CURRENT desktop wallpaper for the screen under the
/// cursor.
///
/// On macOS Sonoma/Sequoia, `NSWorkspace.desktopImageURLForScreen:` returns the
/// generic `DefaultDesktop.heic` when the wallpaper was set via System Settings,
/// and dynamic/aerial wallpapers have no still file at all. So instead we
/// CAPTURE the wallpaper window layer straight off the screen — that's exactly
/// what's rendered, for any wallpaper type — and save it to a temp PNG. Falls
/// back to the NSWorkspace API only if the capture fails.
/// Short-lived cache of the captured wallpaper path. A single screenshot triggers
/// this command several times (per-monitor overlay + Settings preview); without a
/// cache each call did a full-display capture + PNG encode. The wallpaper barely
/// changes second-to-second, so reuse a recent capture.
static WP_CACHE: std::sync::Mutex<Option<(std::time::Instant, String)>> =
    std::sync::Mutex::new(None);
const WP_TTL: std::time::Duration = std::time::Duration::from_secs(2);

#[tauri::command]
pub async fn get_desktop_wallpaper_path() -> Result<String, String> {
    // Serve a fresh-enough cached capture if available.
    if let Ok(guard) = WP_CACHE.lock() {
        if let Some((t, path)) = guard.as_ref() {
            if t.elapsed() < WP_TTL && std::path::Path::new(path).exists() {
                return Ok(path.clone());
            }
        }
    }
    match capture_wallpaper_to_temp() {
        Ok(p) => {
            eprintln!("[wallpaper] captured -> {p}");
            if let Ok(mut guard) = WP_CACHE.lock() {
                *guard = Some((std::time::Instant::now(), p.clone()));
            }
            Ok(p)
        }
        Err(e) => {
            eprintln!("[wallpaper] capture failed ({e}); falling back to NSWorkspace");
            workspace_wallpaper_path()
        }
    }
}

/// NSString (id) → Rust String.
fn nsstring_to_string(s: cocoa::base::id) -> String {
    use cocoa::base::nil;
    use objc::{msg_send, sel, sel_impl};
    use std::ffi::CStr;
    use std::os::raw::c_char;
    if s == nil {
        return String::new();
    }
    unsafe {
        let c: *const c_char = msg_send![s, UTF8String];
        if c.is_null() {
            return String::new();
        }
        CStr::from_ptr(c).to_string_lossy().into_owned()
    }
}

/// CGDirectDisplayID for the screen the cursor is currently on.
fn cursor_display_id() -> u32 {
    use cocoa::foundation::NSPoint;
    use core_graphics::display::CGDisplay;
    use objc::{class, msg_send, sel, sel_impl};
    unsafe {
        let mouse: NSPoint = msg_send![class!(NSEvent), mouseLocation];
        let primary_h = CGDisplay::main().bounds().size.height;
        // NSEvent mouse is bottom-left origin; CGDisplay bounds are top-left.
        let cgp = (mouse.x, primary_h - mouse.y);
        if let Ok(ids) = CGDisplay::active_displays() {
            for id in ids {
                let b = CGDisplay::new(id).bounds();
                if cgp.0 >= b.origin.x
                    && cgp.0 <= b.origin.x + b.size.width
                    && cgp.1 >= b.origin.y
                    && cgp.1 <= b.origin.y + b.size.height
                {
                    return id;
                }
            }
        }
        CGDisplay::main().id
    }
}

/// Encode a captured CGImageRef (BGRA) to an RGBA PNG at `out`. Operates on the
/// raw pointer via CoreGraphics C functions (avoids needing the foreign-types
/// wrapper trait in scope).
fn cgimage_to_png(cgimg: *mut std::os::raw::c_void, out: &str) -> Result<(), String> {
    use core_foundation::base::TCFType;
    use core_foundation::data::{CFData, CFDataRef};
    use std::os::raw::c_void;

    extern "C" {
        fn CGImageGetWidth(image: *mut c_void) -> usize;
        fn CGImageGetHeight(image: *mut c_void) -> usize;
        fn CGImageGetBytesPerRow(image: *mut c_void) -> usize;
        fn CGImageGetDataProvider(image: *mut c_void) -> *mut c_void;
        fn CGDataProviderCopyData(provider: *mut c_void) -> CFDataRef;
    }

    let w = unsafe { CGImageGetWidth(cgimg) };
    let h = unsafe { CGImageGetHeight(cgimg) };
    let bpr = unsafe { CGImageGetBytesPerRow(cgimg) };
    let provider = unsafe { CGImageGetDataProvider(cgimg) };
    if provider.is_null() {
        return Err("no data provider".into());
    }
    let cfdata = unsafe { CFData::wrap_under_create_rule(CGDataProviderCopyData(provider)) };
    let bytes = cfdata.bytes();
    if w == 0 || h == 0 || bytes.len() < bpr * h {
        return Err("unexpected image buffer".into());
    }
    let mut rgba = vec![0u8; w * h * 4];
    for y in 0..h {
        let row = &bytes[y * bpr..y * bpr + w * 4];
        for x in 0..w {
            let p = x * 4;
            let o = (y * w + x) * 4;
            rgba[o] = row[p + 2]; // R (source BGRA)
            rgba[o + 1] = row[p + 1]; // G
            rgba[o + 2] = row[p]; // B
            rgba[o + 3] = 255; // opaque
        }
    }
    let buf = image::RgbaImage::from_raw(w as u32, h as u32, rgba)
        .ok_or("failed to build image buffer")?;
    buf.save(out).map_err(|e| e.to_string())
}

/// Capture the CURRENT rendered desktop wallpaper — any type, including dynamic/
/// aerial — for the screen under the cursor, and write /tmp/ishot_wallpaper.png.
///
/// Uses ScreenCaptureKit's one-shot `SCScreenshotManager.captureImage` with an
/// `SCContentFilter` that EXCLUDES every window, so only the wallpaper remains.
/// (The legacy CGWindowList API returns black for dynamic wallpapers on
/// Sonoma+, and NSWorkspace returns the generic default — see the fallback.)
/// Requires macOS 14+. All ObjC lookups are guarded so older OS / a missing
/// framework degrades to the NSWorkspace fallback instead of crashing.
fn capture_wallpaper_to_temp() -> Result<String, String> {
    use block::ConcreteBlock;
    use cocoa::base::{id, nil};
    use objc::runtime::{Class, BOOL, YES};
    use objc::{class, msg_send, sel, sel_impl};
    use std::os::raw::c_void;
    use std::sync::mpsc;
    use std::time::Duration;

    extern "C" {
        fn CGImageRetain(image: *mut c_void) -> *mut c_void;
        fn CGImageRelease(image: *mut c_void);
    }

    let sc_content = Class::get("SCShareableContent").ok_or("ScreenCaptureKit unavailable")?;
    let sc_filter = Class::get("SCContentFilter").ok_or("SCContentFilter unavailable")?;
    let sc_config = Class::get("SCStreamConfiguration").ok_or("SCStreamConfiguration unavailable")?;
    let sc_shot = Class::get("SCScreenshotManager").ok_or("SCScreenshotManager unavailable")?;

    // Guard the screenshot selector so a mismatch degrades to the fallback
    // instead of crashing with doesNotRecognizeSelector.
    let responds: BOOL = unsafe {
        msg_send![sc_shot, respondsToSelector:
            sel!(captureImageWithFilter:configuration:completionHandler:)]
    };
    if responds != YES {
        return Err("SCScreenshotManager.captureImage unavailable".into());
    }

    // 1. Fetch shareable content (async → block + channel).
    let (tx, rx) = mpsc::channel::<usize>();
    let cb = ConcreteBlock::new(move |content: id, _err: id| {
        let c: id = if content != nil {
            unsafe { msg_send![content, retain] }
        } else {
            nil
        };
        let _ = tx.send(c as usize);
    });
    let cb = cb.copy();
    unsafe {
        let _: () = msg_send![sc_content, getShareableContentWithCompletionHandler: &*cb];
    }
    let content = rx
        .recv_timeout(Duration::from_secs(8))
        .map_err(|_| "timed out fetching shareable content")? as id;
    if content == nil {
        return Err("no shareable content (screen-recording permission?)".into());
    }

    let displays: id = unsafe { msg_send![content, displays] };
    let windows: id = unsafe { msg_send![content, windows] };
    let dcount: usize = unsafe { msg_send![displays, count] };
    if dcount == 0 {
        unsafe {
            let _: () = msg_send![content, release];
        }
        return Err("no SCDisplay".into());
    }

    // Pick the SCDisplay for the screen under the cursor.
    let target = cursor_display_id();
    let mut display: id = nil;
    for i in 0..dcount {
        let d: id = unsafe { msg_send![displays, objectAtIndex: i] };
        let did: u32 = unsafe { msg_send![d, displayID] };
        if did == target {
            display = d;
            break;
        }
    }
    if display == nil {
        display = unsafe { msg_send![displays, objectAtIndex: 0usize] };
    }

    // 2. The wallpaper is itself a WINDOW (owner bundle
    //    "com.apple.wallpaper.WallpaperAgent") — excluding all windows would
    //    capture black. So INCLUDE only the wallpaper window(s) for our display.
    let wcount: usize = unsafe { msg_send![windows, count] };
    let want: id = unsafe { msg_send![class!(NSMutableArray), array] };
    let mut min_layer = i64::MAX;
    let mut all: Vec<(id, i64)> = Vec::new();
    let mut included = 0usize;
    for i in 0..wcount {
        let win: id = unsafe { msg_send![windows, objectAtIndex: i] };
        let layer: i64 = unsafe { msg_send![win, windowLayer] };
        all.push((win, layer));
        if layer < min_layer {
            min_layer = layer;
        }
        let app: id = unsafe { msg_send![win, owningApplication] };
        let bid = if app != nil {
            let b: id = unsafe { msg_send![app, bundleIdentifier] };
            nsstring_to_string(b)
        } else {
            String::new()
        };
        if bid.contains("wallpaper") || bid == "com.apple.dock" {
            unsafe {
                let _: () = msg_send![want, addObject: win];
            }
            included += 1;
        }
    }
    // Fallback: if no wallpaper-owned window matched, take the bottom layer.
    if included == 0 {
        for (win, layer) in &all {
            if *layer == min_layer {
                unsafe {
                    let _: () = msg_send![want, addObject: *win];
                }
                included += 1;
            }
        }
    }
    eprintln!(
        "[wallpaper] including {included} wallpaper window(s), min_layer={min_layer}"
    );
    if included == 0 {
        unsafe {
            let _: () = msg_send![content, release];
        }
        return Err("no wallpaper window found".into());
    }

    let filter: id = unsafe {
        let f: id = msg_send![sc_filter, alloc];
        msg_send![f, initWithDisplay: display includingWindows: want]
    };

    // 3. Config at the display's pixel size (×2 for retina sharpness).
    let wpts: isize = unsafe { msg_send![display, width] };
    let hpts: isize = unsafe { msg_send![display, height] };
    let config: id = unsafe {
        let c: id = msg_send![sc_config, alloc];
        let c: id = msg_send![c, init];
        let _: () = msg_send![c, setWidth: (wpts * 2) as usize];
        let _: () = msg_send![c, setHeight: (hpts * 2) as usize];
        c
    };

    // 4. One-shot screenshot (async → block + channel).
    let (tx2, rx2) = mpsc::channel::<usize>();
    let cb2 = ConcreteBlock::new(move |img: id, _err: id| {
        let p: *mut c_void = if img != nil {
            unsafe { CGImageRetain(img as *mut c_void) }
        } else {
            std::ptr::null_mut()
        };
        let _ = tx2.send(p as usize);
    });
    let cb2 = cb2.copy();
    unsafe {
        let _: () = msg_send![sc_shot,
            captureImageWithFilter: filter
            configuration: config
            completionHandler: &*cb2];
    }
    let cgptr = rx2
        .recv_timeout(Duration::from_secs(8))
        .map_err(|_| "timed out capturing wallpaper")? as *mut c_void;
    unsafe {
        let _: () = msg_send![content, release];
        let _: () = msg_send![filter, release];
        let _: () = msg_send![config, release];
    }
    if cgptr.is_null() {
        return Err("wallpaper capture returned null".into());
    }

    // 5. CGImageRef → RGBA PNG, then release the retained image.
    let out = "/tmp/ishot_wallpaper.png".to_string();
    let res = cgimage_to_png(cgptr, &out);
    unsafe { CGImageRelease(cgptr) };
    res?;
    Ok(out)
}

/// Legacy fallback: the NSWorkspace desktop-image URL for the cursor's screen.
fn workspace_wallpaper_path() -> Result<String, String> {
    use cocoa::base::{id, nil};
    use objc::rc::autoreleasepool;
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;
    use std::os::raw::c_char;

    use cocoa::foundation::{NSPoint, NSRect};

    autoreleasepool(|| unsafe {
        let ws: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        if ws == nil {
            return Err("NSWorkspace unavailable".to_string());
        }
        // Pick the screen the cursor is on (multi-monitor: the one the user is
        // actually capturing), not just `mainScreen` which can be the wrong
        // display and return a different wallpaper. NSEvent.mouseLocation and
        // NSScreen.frame are both Cocoa coords (bottom-left origin, points).
        let mouse: NSPoint = msg_send![class!(NSEvent), mouseLocation];
        let screens: id = msg_send![class!(NSScreen), screens];
        let count: usize = if screens == nil {
            0
        } else {
            msg_send![screens, count]
        };
        let mut screen: id = nil;
        for i in 0..count {
            let s: id = msg_send![screens, objectAtIndex: i];
            let f: NSRect = msg_send![s, frame];
            if mouse.x >= f.origin.x
                && mouse.x <= f.origin.x + f.size.width
                && mouse.y >= f.origin.y
                && mouse.y <= f.origin.y + f.size.height
            {
                screen = s;
                break;
            }
        }
        if screen == nil {
            screen = msg_send![class!(NSScreen), mainScreen];
        }
        if screen == nil {
            return Err("No screen".to_string());
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
        let resolved = CStr::from_ptr(cstr).to_string_lossy().into_owned();
        eprintln!(
            "[wallpaper] mouse=({:.0},{:.0}) screens={} -> path={} exists={}",
            mouse.x,
            mouse.y,
            count,
            resolved,
            std::path::Path::new(&resolved).exists()
        );
        Ok(resolved)
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
