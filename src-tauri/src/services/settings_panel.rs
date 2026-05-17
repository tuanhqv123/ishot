//! Settings NSPanel — Spotlight-style centered panel for shortcuts, history
//! retention, and AI configuration. Mirrors `clipboard_panel.rs` so the two
//! feel identical to the user.

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Position, Size, WebviewUrl};
use tauri_nspanel::{
    tauri_panel, CollectionBehavior, ManagerExt, PanelBuilder, PanelLevel, StyleMask,
};

tauri_panel! {
    panel!(SettingsPanel {
        config: {
            can_become_key_window: true,
            can_become_main_window: false,
            is_floating_panel: true
        }
    })

    panel_event!(SettingsPanelEvents {
        window_did_resign_key(notification: &NSNotification) -> ()
    })
}

pub const PANEL_LABEL: &str = "settings";

const PANEL_WIDTH: f64 = 520.0;
const PANEL_HEIGHT: f64 = 620.0;

pub fn build(app: &AppHandle) {
    if app.get_webview_window(PANEL_LABEL).is_some() {
        return;
    }

    let (x, y) = match app.primary_monitor().ok().flatten() {
        Some(m) => {
            let scale = m.scale_factor();
            let size = m.size();
            let logical_w = size.width as f64 / scale;
            let logical_h = size.height as f64 / scale;
            (
                (logical_w - PANEL_WIDTH) / 2.0,
                (logical_h - PANEL_HEIGHT) / 2.5,
            )
        }
        None => (200.0, 200.0),
    };

    let result = PanelBuilder::<_, SettingsPanel>::new(app, PANEL_LABEL)
        .url(WebviewUrl::App("settings.html".into()))
        .title("Settings")
        .position(Position::Logical(LogicalPosition { x, y }))
        .size(Size::Logical(LogicalSize {
            width: PANEL_WIDTH,
            height: PANEL_HEIGHT,
        }))
        .level(PanelLevel::Floating)
        .has_shadow(true)
        .corner_radius(14.0)
        .hides_on_deactivate(false)
        .no_activate(true)
        .collection_behavior(
            CollectionBehavior::new()
                .can_join_all_spaces()
                .stationary()
                .full_screen_auxiliary(),
        )
        .style_mask(StyleMask::empty().nonactivating_panel().resizable())
        .with_window(|w| {
            w.decorations(false)
                .transparent(true)
                .visible(false)
                .background_color(tauri::window::Color(0, 0, 0, 0))
                .effects(
                    tauri::window::EffectsBuilder::new()
                        .effects(vec![tauri::window::Effect::HudWindow])
                        .state(tauri::window::EffectState::Active)
                        .build(),
                )
        })
        .build();

    match result {
        Ok(panel) => {
            let panel_ref = panel.clone();
            let handler = SettingsPanelEvents::new();
            handler.window_did_resign_key(move |_notification| {
                panel_ref.hide();
            });
            panel.set_event_handler(Some(handler.as_ref()));
        }
        Err(e) => {
            eprintln!("[settings_panel] build failed: {}", e);
        }
    }
}

pub fn toggle(app: &AppHandle) {
    let panel = match app.get_webview_panel(PANEL_LABEL) {
        Ok(p) => p,
        Err(_) => {
            build(app);
            match app.get_webview_panel(PANEL_LABEL) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("[settings_panel] toggle failed: {:?}", e);
                    return;
                }
            }
        }
    };

    if panel.is_visible() {
        panel.hide();
    } else {
        panel.show_and_make_key();
    }
}
