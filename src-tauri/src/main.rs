// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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

#[cfg(target_os = "macos")]
use cocoa::appkit::{NSWindow, NSWindowCollectionBehavior};
#[cfg(target_os = "macos")]
use cocoa::base::{id, nil};
#[cfg(target_os = "macos")]
#[macro_use]
extern crate objc;
#[cfg(target_os = "macos")]
use objc::runtime::Class;

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

struct AppState {
    current_shortcut: Shortcut,
    shortcut_display: String,
}

fn trigger_screenshot(app: &tauri::AppHandle) {
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        use crate::services::screen_capture::ScreenCaptureService;
        
        if let Some(overlay) = app_clone.get_webview_window("overlay") {
            let _ = overlay.show();
            let _ = overlay.set_focus();
        }
        
        match ScreenCaptureService::capture_main_display() {
            Ok((png_data, width, height)) => {
                let base64_data = BASE64.encode(&png_data);
                let _ = app_clone.emit("screenshot-ready", serde_json::json!({
                    "data": base64_data,
                    "width": width,
                    "height": height
                }));
            }
            Err(e) => {
                eprintln!("Screenshot failed: {}", e);
                if let Some(overlay) = app_clone.get_webview_window("overlay") {
                    let _ = overlay.hide();
                }
            }
        }
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
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .setup(move |app| {
            use crate::services::screen_capture::ScreenCaptureService;

            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            #[cfg(target_os = "macos")]
            {
                request_screen_recording_permission();
            }

            // Setup overlay window
            if let Some(overlay) = app.get_webview_window("overlay") {
                if let Ok((_, _, width, height)) = ScreenCaptureService::get_display_bounds() {
                    let _ = overlay.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(0, 0)));
                    let _ = overlay.set_size(tauri::Size::Logical(tauri::LogicalSize::new(width, height)));
                    
                    #[cfg(target_os = "macos")]
                    {
                        let ns_window = overlay.ns_window().unwrap() as id;
                        unsafe {
                            ns_window.setLevel_(1000);
                            ns_window.setCollectionBehavior_(
                                NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary
                            );
                            use cocoa::foundation::{NSRect, NSPoint, NSSize};
                            let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height));
                            let _: () = msg_send![ns_window, setFrame:frame display:true];
                        }
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
            let shortcut_i = MenuItem::with_id(app, "shortcut", format!("Shortcut: {}  ▸", shortcut_display), true, None::<&str>)?;
            let separator1 = PredefinedMenuItem::separator(app)?;
            let launch_i = CheckMenuItem::with_id(app, "launch_at_login", "Launch at Login", true, is_enabled, None::<&str>)?;
            let separator2 = PredefinedMenuItem::separator(app)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit iShot", true, None::<&str>)?;
            
            let menu = Menu::with_items(app, &[&shortcut_i, &separator1, &launch_i, &separator2, &quit_i])?;

            let shortcut_item = shortcut_i.clone();
            
            let _tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| {
                    match event.id.as_ref() {
                        "shortcut" => {
                            open_shortcut_recorder(app);
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
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // Register saved shortcut
            let state_for_shortcut = state.clone();
            let app_handle_for_shortcut = app.handle().clone();
            
            let shortcut = {
                let s = state_for_shortcut.lock().unwrap();
                s.current_shortcut.clone()
            };
            
            app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    trigger_screenshot(&app_handle_for_shortcut);
                }
            })?;

            // Listen for shortcut changes
            let state_for_event = state.clone();
            let app_handle_for_event = app.handle().clone();
            let shortcut_item_for_event = shortcut_item.clone();
            
            app.listen("set-shortcut", move |event| {
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                    let mods_val = payload.get("modifiers").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                    let key_str = payload.get("key").and_then(|v| v.as_str()).unwrap_or("A");
                    
                    // Save to config file
                    let config = Config {
                        modifiers: mods_val,
                        key: key_str.to_string(),
                    };
                    save_config(&config);
                    
                    let mut modifiers = Modifiers::empty();
                    if mods_val & 1 != 0 { modifiers |= Modifiers::META; }
                    if mods_val & 2 != 0 { modifiers |= Modifiers::SHIFT; }
                    if mods_val & 4 != 0 { modifiers |= Modifiers::ALT; }
                    if mods_val & 8 != 0 { modifiers |= Modifiers::CONTROL; }
                    
                    let code = str_to_code(key_str);
                    let new_shortcut = Shortcut::new(Some(modifiers), code);
                    let display = shortcut_to_display(&new_shortcut);
                    
                    let _ = app_handle_for_event.global_shortcut().unregister_all();
                    
                    let app_for_handler = app_handle_for_event.clone();
                    let _ = app_handle_for_event.global_shortcut().on_shortcut(new_shortcut.clone(), move |_app, _shortcut, event| {
                        if event.state == ShortcutState::Pressed {
                            trigger_screenshot(&app_for_handler);
                        }
                    });
                    
                    {
                        let mut s = state_for_event.lock().unwrap();
                        s.current_shortcut = new_shortcut;
                        s.shortcut_display = display.clone();
                    }
                    
                    let _ = shortcut_item_for_event.set_text(format!("Shortcut: {}  ▸", display));
                    
                    if let Some(recorder) = app_handle_for_event.get_webview_window("recorder") {
                        let _ = recorder.close();
                    }
                    
                    println!("Shortcut saved: {}", display);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::screenshot::capture_screen,
            commands::screenshot::capture_region,
            commands::screenshot::get_display_bounds,
            commands::window::show_overlay,
            commands::window::hide_overlay,
            commands::file::copy_to_clipboard,
            commands::file::save_to_file,
            commands::ocr::perform_ocr,
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
fn request_screen_recording_permission() {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }
    
    unsafe {
        let has_access = CGPreflightScreenCaptureAccess();
        println!("Screen recording permission: {}", has_access);
        
        if !has_access {
            let granted = CGRequestScreenCaptureAccess();
            println!("Permission request result: {}", granted);
        }
    }
}

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
        {
            let ns_win = win.ns_window().unwrap() as id;
            unsafe {
                ns_win.setLevel_(1001);
                let _: () = msg_send![ns_win, setOpaque: false];
                let clear_color: id = msg_send![class!(NSColor), clearColor];
                let _: () = msg_send![ns_win, setBackgroundColor: clear_color];
            }
        }
    }
}
