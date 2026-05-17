//! Clipboard history NSPanel — Spotlight-style centered panel.
//!
//! Replaces a regular Tauri window: NSPanel can be a `nonactivating_panel`
//! so opening it does NOT steal focus from the user's foreground app, and
//! it can `can_join_all_spaces` so the panel follows the user across
//! macOS Spaces / fullscreen apps. `window_did_resign_key` is wired to
//! hide the panel when the user clicks outside (Spotlight behaviour).

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Position, Size, WebviewUrl};
use tauri_nspanel::{
    tauri_panel, CollectionBehavior, ManagerExt, PanelBuilder, PanelLevel, StyleMask,
};

tauri_panel! {
    panel!(ClipboardPanel {
        config: {
            can_become_key_window: true,
            can_become_main_window: false,
            is_floating_panel: true
        }
    })

    panel_event!(ClipboardPanelEvents {
        window_did_resign_key(notification: &NSNotification) -> ()
    })
}

pub const PANEL_LABEL: &str = "clipboard_history";

const PANEL_WIDTH: f64 = 640.0;
const PANEL_HEIGHT: f64 = 520.0;

/// Build the panel once at app startup. Idempotent — bails if it already
/// exists so a second call (e.g. from hot-reload during dev) is harmless.
pub fn build(app: &AppHandle) {
    if app.get_webview_window(PANEL_LABEL).is_some() {
        return;
    }

    // Centre on the primary monitor. Fallback to (200, 200) if monitor info
    // isn't available — better to show a panel slightly off-centre than to
    // silently fail to create it.
    let (x, y) = match app.primary_monitor().ok().flatten() {
        Some(m) => {
            let scale = m.scale_factor();
            let size = m.size();
            let logical_w = size.width as f64 / scale;
            let logical_h = size.height as f64 / scale;
            (
                (logical_w - PANEL_WIDTH) / 2.0,
                (logical_h - PANEL_HEIGHT) / 2.5, // slightly above centre — Spotlight does the same
            )
        }
        None => (200.0, 200.0),
    };

    let result = PanelBuilder::<_, ClipboardPanel>::new(app, PANEL_LABEL)
        .url(WebviewUrl::App("clipboard-history.html".into()))
        .title("Clipboard")
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
            // Hide the panel when it loses key focus — matches Spotlight /
            // Alfred behaviour. `order_out` removes it from screen without
            // destroying the webview, so re-show is instant.
            let panel_ref = panel.clone();
            let handler = ClipboardPanelEvents::new();
            handler.window_did_resign_key(move |_notification| {
                panel_ref.hide();
            });
            panel.set_event_handler(Some(handler.as_ref()));
        }
        Err(e) => {
            eprintln!("[clipboard_panel] build failed: {}", e);
        }
    }
}

/// Toggle visibility: show + focus the panel, or hide it if it's already up.
/// Re-creates the panel if it was destroyed.
pub fn toggle(app: &AppHandle) {
    let panel = match app.get_webview_panel(PANEL_LABEL) {
        Ok(p) => p,
        Err(_) => {
            // Panel doesn't exist yet (first call after launch race, or
            // dev hot-reload). Build it now and recurse.
            build(app);
            match app.get_webview_panel(PANEL_LABEL) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("[clipboard_panel] toggle failed: {:?}", e);
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
