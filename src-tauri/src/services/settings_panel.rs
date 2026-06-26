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

/// Centre of the monitor the cursor is on (so Settings opens where the user is
/// looking, not always on the primary display). Accounts for the monitor's
/// origin offset — essential on multi-monitor setups, where the old code
/// assumed the primary monitor sat at (0,0) and drifted off-screen otherwise.
fn centered_position(app: &AppHandle) -> (f64, f64) {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    match monitor {
        Some(m) => {
            let scale = m.scale_factor();
            let pos = m.position();
            let size = m.size();
            let mx = pos.x as f64 / scale;
            let my = pos.y as f64 / scale;
            let mw = size.width as f64 / scale;
            let mh = size.height as f64 / scale;
            (mx + (mw - PANEL_WIDTH) / 2.0, my + (mh - PANEL_HEIGHT) / 2.0)
        }
        None => (200.0, 200.0),
    }
}

/// Re-centre the existing panel on the active monitor before showing it.
fn recenter(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(PANEL_LABEL) {
        let (x, y) = centered_position(app);
        let _ = win.set_position(Position::Logical(LogicalPosition { x, y }));
    }
}

pub fn build(app: &AppHandle) {
    if app.get_webview_window(PANEL_LABEL).is_some() {
        return;
    }

    let (x, y) = centered_position(app);

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

/// Ensure the settings panel is shown (build it if needed). Unlike `toggle`,
/// this never hides — used when another flow (e.g. AI chat with no API key)
/// needs to send the user straight to Settings.
pub fn show(app: &AppHandle) {
    let panel = match app.get_webview_panel(PANEL_LABEL) {
        Ok(p) => p,
        Err(_) => {
            build(app);
            match app.get_webview_panel(PANEL_LABEL) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("[settings_panel] show failed: {:?}", e);
                    return;
                }
            }
        }
    };
    recenter(app);
    panel.show_and_make_key();
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
        recenter(app);
        panel.show_and_make_key();
    }
}
