// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![allow(unexpected_cfgs)]

mod commands;
mod error;
mod services;

use std::sync::{Arc, Mutex};
use std::path::PathBuf;
use tauri::{Emitter, Listener, Manager};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, CheckMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut, Code, ShortcutState};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde::{Deserialize, Serialize};
use crate::services::scroll_capture::ScrollCaptureState;

#[cfg(target_os = "macos")]
#[allow(deprecated)]
use cocoa::appkit::{NSWindow, NSWindowCollectionBehavior};
#[cfg(target_os = "macos")]
#[allow(deprecated)]
use cocoa::base::id;
#[cfg(target_os = "macos")]
#[macro_use]
extern crate objc;

// Non-activating panel for the capture overlay lives in its own module: its
// macro pulls in objc2 types (NSWindow/msg_send) that would collide with the
// cocoa/objc used throughout this file.
#[cfg(target_os = "macos")]
mod overlay_panel;

#[derive(Serialize, Deserialize, Clone)]
struct Config {
    modifiers: u32,
    key: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            modifiers: 3, // META | SHIFT
            key: "A".to_string(),
        }
    }
}

fn get_config_path() -> PathBuf {
    let config_dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    config_dir.join("ishot").join("config.json")
}

fn load_config() -> Config {
    let path = get_config_path();
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(config) = serde_json::from_str(&content) {
                return config;
            }
        }
    }
    Config::default()
}

fn save_config(config: &Config) {
    let path = get_config_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, serde_json::to_string_pretty(config).unwrap_or_default());
}

fn config_to_shortcut(config: &Config) -> Shortcut {
    let mut modifiers = Modifiers::empty();
    if config.modifiers & 1 != 0 { modifiers |= Modifiers::META; }
    if config.modifiers & 2 != 0 { modifiers |= Modifiers::SHIFT; }
    if config.modifiers & 4 != 0 { modifiers |= Modifiers::ALT; }
    if config.modifiers & 8 != 0 { modifiers |= Modifiers::CONTROL; }
    Shortcut::new(Some(modifiers), str_to_code(&config.key))
}

fn spec_to_shortcut(spec: &crate::services::settings::ShortcutSpec) -> Shortcut {
    let mut modifiers = Modifiers::empty();
    if spec.modifiers & 1 != 0 { modifiers |= Modifiers::META; }
    if spec.modifiers & 2 != 0 { modifiers |= Modifiers::SHIFT; }
    if spec.modifiers & 4 != 0 { modifiers |= Modifiers::ALT; }
    if spec.modifiers & 8 != 0 { modifiers |= Modifiers::CONTROL; }
    Shortcut::new(Some(modifiers), str_to_code(&spec.key))
}

/// Drop all current global shortcut registrations and re-register from the
/// cached settings. Called after `save_settings` so a keybind change takes
/// effect without restarting the app.
pub fn re_register_shortcuts(app: &tauri::AppHandle) {
    let settings = crate::services::settings::load_cached();
    let _ = app.global_shortcut().unregister_all();

    let capture = spec_to_shortcut(&settings.shortcuts.capture);
    let app_capture = app.clone();
    if let Err(e) = app
        .global_shortcut()
        .on_shortcut(capture, move |_app, _sc, event| {
            if event.state == ShortcutState::Pressed {
                trigger_screenshot(&app_capture);
            }
        })
    {
        eprintln!("[shortcuts] capture register failed: {}", e);
    }

    let clipboard = spec_to_shortcut(&settings.shortcuts.clipboard);
    let app_clip = app.clone();
    if let Err(e) = app
        .global_shortcut()
        .on_shortcut(clipboard, move |_app, _sc, event| {
            if event.state == ShortcutState::Pressed {
                services::clipboard_panel::toggle(&app_clip);
            }
        })
    {
        eprintln!("[shortcuts] clipboard register failed: {}", e);
    }
}

struct AppState {
    current_shortcut: Shortcut,
    shortcut_display: String,
}

fn trigger_screenshot(app: &tauri::AppHandle) {
    use crate::services::screen_capture::ScreenCaptureService;

    // Gate on Screen Recording: without it, capture returns black/garbage and
    // the overlay would just look broken. Guide the user to Settings instead.
    #[cfg(target_os = "macos")]
    if !has_screen_recording() {
        println!("[capture] screen recording not granted — guiding user to Settings");
        screen_recording_guidance(app);
        return;
    }

    let monitors = match ScreenCaptureService::get_monitors_info() {
        Ok(m) => m,
        Err(e) => { eprintln!("get_monitors_info failed: {}", e); return; }
    };
    println!("[monitors] count={} {:?}", monitors.len(), monitors);

    // Clear old screenshot data first so overlay doesn't flash stale content
    let _ = app.emit("screenshot-clear", ());

    // Broadcast the global cursor position to every overlay so window-select
    // hover follows the cursor across monitors (one highlight, no click needed).
    crate::services::cursor_track::start(app.clone());

    // Show the main overlay on the primary monitor
    if let Some(overlay) = app.get_webview_window("overlay") {
        if let Some(m) = monitors.first() {
            let _ = overlay.set_position(tauri::Position::Logical(
                tauri::LogicalPosition::new(m.x, m.y),
            ));
            let _ = overlay.set_size(tauri::Size::Logical(tauri::LogicalSize::new(m.width, m.height)));
        }
        let _ = overlay.show();
        // NOTE: intentionally no set_focus() — see CLAUDE.md. The overlay must appear on top
        // of any active app without stealing keyboard focus from it.
        // Enable mouseMove events without button-down — required for the
        // hover-window-detect path. NSWindow defaults to firing mouseMove
        // only after a click, which is why the user previously had to
        // click once before hover started working.
        #[cfg(target_os = "macos")]
        #[allow(deprecated)]
        if let Ok(ns_ptr) = overlay.ns_window() {
            let ns_win = ns_ptr as id;
            unsafe { ns_win.setAcceptsMouseMovedEvents_(objc::runtime::YES); }
        }

        // Force the (now non-activating panel) overlay onto the active Space and
        // above fullscreen content — needed when an app is in native fullscreen.
        #[cfg(target_os = "macos")]
        order_overlay_over_fullscreen(&overlay);

        // Activate the application so the webview's CSS `cursor: crosshair`
        // takes effect immediately. Without activating, iShot is a background
        // menu-bar app (LSUIElement=true) and macOS routes cursor control to
        // whichever app *is* active — so our crosshair cursor never appears.
        //
        // This is just app-level activate, NOT `set_focus()` on the overlay.
        // The foreground app keeps its window in front of ours visually as
        // far as the user's workflow is concerned; we're only briefly
        // becoming the cursor-owning app for the selecting phase. JS calls
        // `release_overlay_cursor` (now deactivates) on commit/cancel so the
        // previous app reclaims activity.
        let _ = app.run_on_main_thread(|| {
            unsafe {
                let ns_app: id = objc::msg_send![objc::class!(NSApplication), sharedApplication];
                let _: () = objc::msg_send![ns_app, activateIgnoringOtherApps: objc::runtime::YES];
            }
        });
    }

    // Create or reuse overlay windows for secondary monitors
    for (i, m) in monitors.iter().enumerate().skip(1) {
        let label = format!("overlay_{}", i);
        // Reuse existing window if present
        if let Some(existing) = app.get_webview_window(&label) {
            let _ = existing.set_position(tauri::Position::Logical(
                tauri::LogicalPosition::new(m.x, m.y),
            ));
            let _ = existing.set_size(tauri::Size::Logical(tauri::LogicalSize::new(m.width, m.height)));
            let _ = existing.show();
            #[cfg(target_os = "macos")]
            order_overlay_over_fullscreen(&existing);
            continue;
        }
        let builder = tauri::WebviewWindowBuilder::new(
            app,
            &label,
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("")
        .inner_size(m.width, m.height)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .resizable(false)
        .visible(false)
        .focused(false)
        // First click registers even when the panel isn't active — without
        // this, over a fullscreen app the first click only woke the panel and a
        // second was needed to actually select.
        .accept_first_mouse(true);

        match builder.build() {
            Ok(win) => {
                let _ = win.set_position(tauri::Position::Logical(
                    tauri::LogicalPosition::new(m.x, m.y),
                ));
                #[cfg(target_os = "macos")]
                {
                    // Same as the primary overlay: convert to a non-activating
                    // panel so this monitor's overlay can also appear over a
                    // fullscreen app on it.
                    overlay_panel::convert(&win);
                    #[allow(deprecated)]
                    if let Ok(ns_ptr) = win.ns_window() {
                        let ns_win = ns_ptr as id;
                        unsafe {
                            ns_win.setLevel_(1000);
                            ns_win.setCollectionBehavior_(
                                NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary
                                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
                            );
                            ns_win.setAcceptsMouseMovedEvents_(objc::runtime::YES);
                        }
                    }
                }
                let _ = win.show();
                #[cfg(target_os = "macos")]
                order_overlay_over_fullscreen(&win);
                println!("[overlay_{}] created at ({},{} {}x{})", i, m.x, m.y, m.width, m.height);
            }
            Err(e) => eprintln!("[overlay_{}] failed: {}", i, e),
        }
    }

    // Capture in background thread
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let monitors = ScreenCaptureService::get_monitors_info().unwrap_or_default();

        let mut displays: Vec<serde_json::Value> = Vec::new();
        for (i, monitor) in monitors.iter().enumerate() {
            let display_num = i + 1;
            match ScreenCaptureService::capture_display(display_num) {
                Ok((png_data, w, h)) => {
                    let b64 = BASE64.encode(&png_data);
                    displays.push(serde_json::json!({
                        "data": b64,
                        "width": w,
                        "height": h,
                        "monitor": monitor,
                    }));
                }
                Err(e) => eprintln!("[capture] display {} failed: {}", display_num, e),
            }
        }

        let _ = app_clone.emit("screenshot-ready", serde_json::json!({
            "displays": displays,
            "monitors": monitors,
        }));
    });
}

fn shortcut_to_display(shortcut: &Shortcut) -> String {
    let mut parts = Vec::new();
    let mods = shortcut.mods;
    if mods.contains(Modifiers::META) { parts.push("⌘".to_string()); }
    if mods.contains(Modifiers::SHIFT) { parts.push("⇧".to_string()); }
    if mods.contains(Modifiers::ALT) { parts.push("⌥".to_string()); }
    if mods.contains(Modifiers::CONTROL) { parts.push("⌃".to_string()); }
    let key = format!("{:?}", shortcut.key);
    let key_display = key.replace("Key", "").replace("Digit", "");
    parts.push(key_display);
    parts.join("")
}

/// Check the updater endpoint, download + install if a newer signed bundle
/// is available, then restart the app.
///
/// All user-facing status flows through `Notification` so the menu-bar app
/// stays out of the way — there's no main window we can drop a dialog into.
/// Errors fall through to a "couldn't check" notification rather than
/// being silently swallowed.
async fn check_for_updates(app: tauri::AppHandle) {
    use tauri_plugin_updater::UpdaterExt;

    // Update status shows as the in-app HUD pill (bottom-center, auto-fades)
    // instead of a Notification Center banner stuck in the top-right corner.
    let notify = |body: &str| {
        services::hud::show(&app, body);
    };

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[updater] failed to construct updater: {}", e);
            notify("Couldn't check for updates.");
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            notify(&format!(
                "Downloading update {} → installing…",
                update.version
            ));
            // `download_and_install` streams the signed archive, verifies the
            // signature against `pubkey` in tauri.conf.json, swaps the .app on
            // disk, and returns. We then restart via the app handle.
            let result = update
                .download_and_install(|_chunk, _total| {}, || {})
                .await;
            match result {
                Ok(_) => {
                    notify("Update installed. Restarting…");
                    app.restart();
                }
                Err(e) => {
                    eprintln!("[updater] install failed: {}", e);
                    notify("Update download failed.");
                }
            }
        }
        Ok(None) => notify("You're on the latest version."),
        Err(e) => {
            eprintln!("[updater] check failed: {}", e);
            notify("Couldn't reach the update server.");
        }
    }
}

fn main() {
    // Load saved config
    let config = load_config();
    let initial_shortcut = config_to_shortcut(&config);
    let initial_display = shortcut_to_display(&initial_shortcut);
    
    let state = Arc::new(Mutex::new(AppState {
        current_shortcut: initial_shortcut,
        shortcut_display: initial_display,
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Second launch blocked. Trigger a capture in the existing instance so the user gets a useful response.
            eprintln!("[single-instance] duplicate launch blocked");
            trigger_screenshot(app);
        }))
        .manage(std::sync::Arc::new(std::sync::Mutex::new(ScrollCaptureState::default())))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_nspanel::init())
        .setup(move |app| {
            use crate::services::screen_capture::ScreenCaptureService;

            // Load persistent settings once into the in-memory cache so hot
            // readers (clipboard pruning, panel construction) don't touch
            // disk on every access.
            crate::services::settings::init_cache();

            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            #[cfg(target_os = "macos")]
            {
                request_screen_recording_permission();
            }

            // Setup overlay window on primary display
            if let Some(overlay) = app.get_webview_window("overlay") {
                if let Ok((x, y, width, height)) = ScreenCaptureService::get_display_bounds() {
                    let _ = overlay.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
                    let _ = overlay.set_size(tauri::Size::Logical(tauri::LogicalSize::new(width, height)));

                    #[cfg(target_os = "macos")]
                    #[allow(deprecated)]
                    if let Ok(ns_ptr) = overlay.ns_window() {
                        let ns_window = ns_ptr as id;
                        unsafe {
                            ns_window.setLevel_(1000);
                            ns_window.setCollectionBehavior_(
                                NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary
                            );
                            use cocoa::foundation::{NSRect, NSPoint, NSSize};
                            #[allow(deprecated)]
                            let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height));
                            let _: () = msg_send![ns_window, setFrame:frame display:true];
                        }
                    }

                    // Convert to a non-activating panel + allow joining the
                    // active fullscreen Space. After this, the existing
                    // overlay.show()/hide() keep working but no longer activate
                    // iShot, so the overlay can appear over a fullscreen app.
                    #[cfg(target_os = "macos")]
                    if overlay_panel::convert(&overlay) {
                        #[allow(deprecated)]
                        if let Ok(ns_ptr) = overlay.ns_window() {
                            let ns_window = ns_ptr as id;
                            unsafe {
                                ns_window.setLevel_(1000);
                                ns_window.setCollectionBehavior_(
                                    NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                                    | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary
                                    | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary,
                                );
                            }
                        }
                        println!("[overlay] non-activating panel ready (over-fullscreen capable)");
                    } else {
                        eprintln!("[overlay] to_panel failed — staying a plain window");
                    }
                }
            }

            let autostart = app.autolaunch();
            let is_enabled = autostart.is_enabled().unwrap_or(false);

            let shortcut_display = {
                let s = state.lock().unwrap();
                s.shortcut_display.clone()
            };

            // Create menu items
            // Tray menu structure (top → bottom):
            //   Capture                 — invoke screenshot directly
            //   Clipboard History       — open the spotlight panel directly
            //   ─────────────
            //   Settings…
            //   Check for Updates…
            //   Launch at Login (check)
            //   ─────────────
            //   Quit iShot
            let capture_i = MenuItem::with_id(app, "capture", "Capture", true, None::<&str>)?;
            let record_i = MenuItem::with_id(app, "record", "Record Screen", true, None::<&str>)?;
            let clipboard_i = MenuItem::with_id(app, "clipboard_history", "Clipboard History", true, None::<&str>)?;
            let separator1 = PredefinedMenuItem::separator(app)?;
            let settings_i = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let check_update_i = MenuItem::with_id(app, "check_update", "Check for Updates…", true, None::<&str>)?;
            let launch_i = CheckMenuItem::with_id(app, "launch_at_login", "Launch at Login", true, is_enabled, None::<&str>)?;
            let separator2 = PredefinedMenuItem::separator(app)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit iShot", true, None::<&str>)?;

            let menu = Menu::with_items(
                app,
                &[
                    &capture_i,
                    &record_i,
                    &clipboard_i,
                    &separator1,
                    &settings_i,
                    &check_update_i,
                    &launch_i,
                    &separator2,
                    &quit_i,
                ],
            )?;
            // `shortcut_display` no longer surfaces in the menu (its label was
            // dropped per the new tray layout), but keep the variable used so
            // the existing tray-menu logic still compiles cleanly.
            let _ = shortcut_display;
            
            // Load the dedicated tray_icon.png (monochrome daisy on transparent
            // BG) and mark it as a macOS template image. With `icon_as_template`
            // true the system tints the icon white on dark menubars and black
            // on light menubars automatically — Apple HIG compliant.
            let tray_icon_bytes = include_bytes!("../icons/tray_icon.png");
            let tray_icon = tauri::image::Image::from_bytes(tray_icon_bytes)
                .expect("failed to decode tray icon");
            let _tray = TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .icon_as_template(true)
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| {
                    match event.id.as_ref() {
                        "capture" => {
                            // Trigger screenshot directly — same code path the
                            // global shortcut uses.
                            trigger_screenshot(app);
                        }
                        "record" => {
                            open_recorder_window(app);
                        }
                        "launch_at_login" => {
                            let autostart = app.autolaunch();
                            let is_enabled = autostart.is_enabled().unwrap_or(false);
                            if is_enabled {
                                let _ = autostart.disable();
                            } else {
                                let _ = autostart.enable();
                            }
                        }
                        "clipboard_history" => {
                            services::clipboard_panel::toggle(app);
                        }
                        "settings" => {
                            services::settings_panel::toggle(app);
                        }
                        "check_update" => {
                            // Spawn the updater check so we don't block the menu
                            // event handler. Status (found / up-to-date / error)
                            // surfaces as native notifications.
                            let app_handle = app.clone();
                            tauri::async_runtime::spawn(async move {
                                check_for_updates(app_handle).await;
                            });
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // Register shortcuts from persisted settings (capture + clipboard).
            // The recorder window UI in `set-shortcut` still owns the capture
            // hotkey separately; this seeds both from the settings file at
            // launch so a user who only edits via the new Settings panel gets
            // the right bindings without going through the legacy recorder.
            let settings_now = crate::services::settings::load_cached();
            let capture_shortcut = spec_to_shortcut(&settings_now.shortcuts.capture);
            let app_handle_for_shortcut = app.handle().clone();
            app.global_shortcut().on_shortcut(capture_shortcut, move |_app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    trigger_screenshot(&app_handle_for_shortcut);
                }
            })?;

            let clipboard_shortcut = spec_to_shortcut(&settings_now.shortcuts.clipboard);
            let app_handle_for_clipboard = app.handle().clone();
            app.global_shortcut().on_shortcut(clipboard_shortcut, move |_app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    services::clipboard_panel::toggle(&app_handle_for_clipboard);
                }
            })?;

            // Sync the in-memory legacy `state` (used by the menu label /
            // recorder window) with whatever the settings file says, so the
            // tray label and the recorder agree on the current capture combo.
            {
                let mut s = state.lock().unwrap();
                s.current_shortcut = capture_shortcut;
                s.shortcut_display = shortcut_to_display(&capture_shortcut);
            }

            // Build the Spotlight-style panels (hidden until toggled).
            services::clipboard_panel::build(&app.handle());
            services::settings_panel::build(&app.handle());

            // Start clipboard polling thread.
            services::clipboard_history::start_polling(app.handle().clone());

            // Legacy `set-shortcut` event listener kept for backwards-compat
            // with the old recorder.html window: still writes the config and
            // re-registers the capture shortcut so users who happen to open
            // the old window don't get a broken save flow. Settings panel is
            // now the authoritative path (it calls re_register_shortcuts).
            let state_for_event = state.clone();
            let app_handle_for_event = app.handle().clone();

            app.listen("set-shortcut", move |event| {
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                    let mods_val = payload.get("modifiers").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                    let key_str = payload.get("key").and_then(|v| v.as_str()).unwrap_or("A");

                    let config = Config { modifiers: mods_val, key: key_str.to_string() };
                    save_config(&config);

                    let new_shortcut = config_to_shortcut(&config);
                    let display = shortcut_to_display(&new_shortcut);

                    let _ = app_handle_for_event.global_shortcut().unregister_all();
                    let app_for_handler = app_handle_for_event.clone();
                    let _ = app_handle_for_event
                        .global_shortcut()
                        .on_shortcut(new_shortcut, move |_app, _sc, event| {
                            if event.state == ShortcutState::Pressed {
                                trigger_screenshot(&app_for_handler);
                            }
                        });

                    {
                        let mut s = state_for_event.lock().unwrap();
                        s.current_shortcut = new_shortcut;
                        s.shortcut_display = display.clone();
                    }

                    if let Some(recorder) = app_handle_for_event.get_webview_window("recorder") {
                        let _ = recorder.close();
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            release_overlay_cursor,
            commands::screenshot::capture_screen,
            commands::screenshot::capture_region,
            commands::screenshot::get_display_bounds,
            commands::screenshot::get_monitors_info,
            commands::window::show_overlay,
            commands::window::hide_overlay,
            commands::window::set_overlay_passthrough,
            commands::window::show_scroll_panel,
            commands::window::hide_scroll_panel,
            commands::window::show_scroll_border,
            commands::window::hide_scroll_border,
            commands::file::copy_to_clipboard,
            commands::file::copy_text_to_clipboard,
            commands::file::save_to_file,
            commands::ocr::perform_ocr,
            commands::translate::translate_text,
            commands::scroll_capture::prepare_scroll_capture,
            commands::scroll_capture::start_scroll_capture,
            commands::scroll_capture::start_auto_scroll_capture,
            commands::scroll_capture::stop_scroll_capture,
            commands::scroll_capture::finalize_scroll_to_clipboard,
            commands::scroll_capture::cancel_scroll_capture,
            commands::scroll_capture::get_scroll_capture_state,
            commands::clipboard_history::list_clipboard_history,
            commands::clipboard_history::read_clipboard_text,
            commands::clipboard_history::copy_clipboard_item,
            commands::clipboard_history::delete_clipboard_item,
            commands::clipboard_history::clear_clipboard_history,
            commands::clipboard_history::toggle_clipboard_pause,
            commands::clipboard_history::is_clipboard_paused,
            commands::window_enum::snapshot_windows,
            commands::window_enum::find_window_at,
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::settings::has_api_key,
            commands::settings::set_api_key,
            commands::settings::clear_api_key,
            commands::settings::open_settings,
            commands::ai_chat::ai_chat_stream,
            commands::ai_chat::list_ai_models,
            commands::appearance::get_desktop_wallpaper_path,
            commands::appearance::read_image_as_data_url,
            commands::hud::show_hud,
            commands::recorder::list_capture_targets,
            commands::recorder::recording_status,
            commands::recorder::set_recorder_expanded,
            commands::recorder::start_recording,
            commands::recorder::pause_recording,
            commands::recorder::resume_recording,
            commands::recorder::stop_recording,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn str_to_code(s: &str) -> Code {
    match s {
        "A" => Code::KeyA, "B" => Code::KeyB, "C" => Code::KeyC, "D" => Code::KeyD,
        "E" => Code::KeyE, "F" => Code::KeyF, "G" => Code::KeyG, "H" => Code::KeyH,
        "I" => Code::KeyI, "J" => Code::KeyJ, "K" => Code::KeyK, "L" => Code::KeyL,
        "M" => Code::KeyM, "N" => Code::KeyN, "O" => Code::KeyO, "P" => Code::KeyP,
        "Q" => Code::KeyQ, "R" => Code::KeyR, "S" => Code::KeyS, "T" => Code::KeyT,
        "U" => Code::KeyU, "V" => Code::KeyV, "W" => Code::KeyW, "X" => Code::KeyX,
        "Y" => Code::KeyY, "Z" => Code::KeyZ,
        "0" => Code::Digit0, "1" => Code::Digit1, "2" => Code::Digit2, "3" => Code::Digit3,
        "4" => Code::Digit4, "5" => Code::Digit5, "6" => Code::Digit6, "7" => Code::Digit7,
        "8" => Code::Digit8, "9" => Code::Digit9,
        "F1" => Code::F1, "F2" => Code::F2, "F3" => Code::F3, "F4" => Code::F4,
        "F5" => Code::F5, "F6" => Code::F6, "F7" => Code::F7, "F8" => Code::F8,
        "F9" => Code::F9, "F10" => Code::F10, "F11" => Code::F11, "F12" => Code::F12,
        "Space" => Code::Space,
        _ => Code::KeyA,
    }
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
    /// Security-shield level — above normal AND fullscreen content. Computed at
    /// runtime. The reliable level for an overlay that must sit over a
    /// fullscreen app.
    fn CGShieldingWindowLevel() -> i32;
}

#[cfg(target_os = "macos")]
fn overlay_window_level() -> i64 {
    unsafe { CGShieldingWindowLevel() as i64 }
}

/// Order an overlay panel onto the active Space (incl. another app's fullscreen)
/// and above its content. Re-asserts collection behavior + level every show:
/// `orderFrontRegardless` is required because iShot is an inactive (Accessory)
/// app — plain `show()`/`orderFront` is ignored, leaving the overlay off the
/// active fullscreen Space.
#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn order_overlay_over_fullscreen(window: &tauri::WebviewWindow) {
    if let Ok(ns_ptr) = window.ns_window() {
        let ns_win = ns_ptr as id;
        unsafe {
            // Ensure the NON-ACTIVATING PANEL style bit is set. The tauri_panel
            // config (can_become_key_window etc.) may not actually set the
            // styleMask bit, and without it the panel still activates → can't
            // join a fullscreen Space. 1<<7 = NSWindowStyleMaskNonactivatingPanel.
            let style: u64 = msg_send![ns_win, styleMask];
            let _: () = msg_send![ns_win, setStyleMask: style | (1u64 << 7)];

            ns_win.setCollectionBehavior_(
                NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                    | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary
                    | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary,
            );
            ns_win.setLevel_(overlay_window_level());
            let _: () = msg_send![ns_win, orderFrontRegardless];
        }
    }
}

#[cfg(target_os = "macos")]
fn has_screen_recording() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

#[cfg(target_os = "macos")]
fn request_screen_recording_permission() {
    unsafe {
        let has_access = CGPreflightScreenCaptureAccess();
        println!("Screen recording permission: {}", has_access);
        if !has_access {
            let granted = CGRequestScreenCaptureAccess();
            println!("Permission request result: {}", granted);
        }
    }
}

/// Screen Recording is a SIP-protected TCC permission — macOS provides NO in-app
/// one-click Allow for it (unlike Camera/Mic). The most we can do is fire the
/// native prompt, deep-link to the exact Settings pane, and tell the user to
/// relaunch (the grant doesn't take effect until the app restarts). Called when
/// a capture is attempted without the permission, instead of showing a broken
/// black overlay.
#[cfg(target_os = "macos")]
fn screen_recording_guidance(app: &tauri::AppHandle) {
    use tauri_plugin_notification::NotificationExt;
    unsafe {
        let _ = CGRequestScreenCaptureAccess();
    }
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        .spawn();
    let _ = app
        .notification()
        .builder()
        .title("iShot needs Screen Recording")
        .body("Turn on iShot under Privacy & Security → Screen Recording, then relaunch iShot.")
        .show();
}

/// Deactivate iShot when the selecting stage ends so the previously-foreground
/// app reclaims its active status and its windows resume cursor control. Called
/// from JS on commit / cancel. Dispatches to the main thread.
#[tauri::command]
fn release_overlay_cursor(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.run_on_main_thread(|| {
            unsafe {
                let ns_app: id = objc::msg_send![objc::class!(NSApplication), sharedApplication];
                let _: () = objc::msg_send![ns_app, deactivate];
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Open (or focus) the Loom-style record control toolbar — a small always-on-top
/// bar at the bottom-center of the active monitor with source/mic/camera options
/// and Start/Pause/Stop. The native capture engine hangs off its commands.
fn open_recorder_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("recorder_bar") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    const BAR_W: f64 = 540.0;
    const BAR_H: f64 = 68.0;
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let (x, y) = match monitor {
        Some(m) => {
            let s = m.scale_factor();
            let mx = m.position().x as f64 / s;
            let my = m.position().y as f64 / s;
            let mw = m.size().width as f64 / s;
            let mh = m.size().height as f64 / s;
            (mx + (mw - BAR_W) / 2.0, my + mh - BAR_H - mh * 0.06)
        }
        None => (200.0, 200.0),
    };
    let _ = tauri::WebviewWindowBuilder::new(
        app,
        "recorder_bar",
        tauri::WebviewUrl::App("recording.html".into()),
    )
    .title("Record")
    .inner_size(BAR_W, BAR_H)
    .position(x, y)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    // resizable(true) is REQUIRED so the JS side can grow the window upward to
    // show the source dropdown (a 68px window would clip the menu).
    .resizable(true)
    .visible(true)
    .build();
    // TODO(capture-engine): setSharingType:0 so the bar itself isn't recorded.
}

#[allow(dead_code)] // legacy recorder window — kept while the old HTML entry exists
fn open_shortcut_recorder(app: &tauri::AppHandle) {
    if let Some(recorder) = app.get_webview_window("recorder") {
        let _ = recorder.set_focus();
        return;
    }
    
    let recorder = tauri::WebviewWindowBuilder::new(
        app,
        "recorder",
        tauri::WebviewUrl::App("recorder.html".into())
    )
    .title("")
    .inner_size(236.0, 96.0)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .closable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .visible(true)
    .center()
    .build();
    
    if let Ok(win) = recorder {
        let _ = win.set_focus();
        
        #[cfg(target_os = "macos")]
        #[allow(deprecated)]
        if let Ok(ns_ptr) = win.ns_window() {
            let ns_win = ns_ptr as id;
            unsafe {
                ns_win.setLevel_(1001);
                let _: () = msg_send![ns_win, setOpaque: false];
                let clear_color: id = msg_send![class!(NSColor), clearColor];
                let _: () = msg_send![ns_win, setBackgroundColor: clear_color];
            }
        }
    }
}
