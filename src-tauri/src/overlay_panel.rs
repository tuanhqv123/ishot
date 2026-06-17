//! Non-activating NSPanel class for the capture overlay.
//!
//! Isolated in its own module because `tauri_panel!` expands to objc2 types
//! (`NSWindow`, `msg_send`) that collide with the cocoa/objc used in main.rs.
//!
//! Converting the overlay window to this panel makes `show()` order it front
//! WITHOUT activating the app, which is what lets the overlay appear over
//! ANOTHER app's native-fullscreen Space. `can_become_key_window: true` keeps
//! mouse + keyboard working (the `_setPreventsActivation` hack killed those).

use tauri::{Manager, WebviewWindow};
use tauri_nspanel::{tauri_panel, WebviewWindowExt};

tauri_panel! {
    panel!(OverlayPanel {
        config: {
            can_become_key_window: true,
            can_become_main_window: false,
            is_floating_panel: true
        }
    })
}

/// Convert an existing overlay window into the non-activating panel.
/// Returns true on success.
pub fn convert(window: &WebviewWindow) -> bool {
    window.to_panel::<OverlayPanel>().is_ok()
}
