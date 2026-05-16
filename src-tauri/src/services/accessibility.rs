//! Accessibility permission helpers (macOS).
//!
//! Scroll capture dispatches `CGScrollEvent` to drive the focused app's
//! scrolling. Posting synthesised input events requires the "Accessibility"
//! permission under macOS Privacy & Security. Without it the post calls
//! silently no-op and the user never sees the app in the permission list.
//!
//! `AXIsProcessTrustedWithOptions(prompt=true)` is the right call: it
//! returns the current trust state AND, if not trusted, asks the system
//! to surface the consent dialog and register the app in System Settings →
//! Privacy & Security → Accessibility. The user can then toggle the
//! switch — no manual "drag the app icon into the list" step.

use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::{CFString, CFStringRef};

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrustedWithOptions(options: *const std::os::raw::c_void) -> bool;
    /// `"AXTrustedCheckOptionPrompt"` — when paired with CFBoolean::true,
    /// causes AXIsProcessTrustedWithOptions to show the system consent
    /// dialog on the first untrusted call.
    static kAXTrustedCheckOptionPrompt: CFStringRef;
}

/// Returns `true` if the process currently has Accessibility permission.
/// When `prompt` is true and permission is missing, macOS surfaces the
/// consent dialog and adds the app to the Accessibility list (the user
/// only needs to flip the toggle — no drag-and-drop required).
///
/// Safe to call repeatedly; macOS dedupes the prompt internally so the
/// dialog only appears on the very first request per session.
pub fn check_accessibility(prompt: bool) -> bool {
    unsafe {
        let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
        let value = CFBoolean::from(prompt);
        let opts = CFDictionary::from_CFType_pairs(&[(key, value)]);
        AXIsProcessTrustedWithOptions(opts.as_concrete_TypeRef() as *const _)
    }
}
