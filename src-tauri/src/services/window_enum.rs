//! On-screen window enumeration via CoreGraphics (macOS).
//!
//! Backs the "window detect on hover" feature: the frontend asks the backend
//! for a snapshot of all visible top-level windows so it can highlight the
//! one under the cursor. We rely on `CGWindowListCopyWindowInfo`, which is
//! the same API the macOS screenshot tool uses, so we get the same view of
//! the window stack the user sees (front-to-back z-order, on-screen only,
//! desktop elements excluded).
//!
//! Coordinates returned here are *logical* screen coordinates with the
//! origin at the top-left of the primary display — matching what the
//! Tauri/web frontend uses for mouse positions. CG returns the bounds in
//! the same space (Quartz "global display coordinates"), so no transform is
//! needed.

use core_foundation::array::{CFArrayGetCount, CFArrayGetValueAtIndex, CFArrayRef};
use core_foundation::base::{CFType, CFTypeRef, TCFType};
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_graphics::window::{
    kCGNullWindowID, kCGWindowAlpha, kCGWindowBounds, kCGWindowIsOnscreen, kCGWindowLayer,
    kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly, kCGWindowName,
    kCGWindowNumber, kCGWindowOwnerName, kCGWindowOwnerPID, CGWindowListCopyWindowInfo,
};

#[derive(Clone, Debug, serde::Serialize)]
pub struct WindowInfo {
    /// kCGWindowNumber — stable window ID for the lifetime of the window.
    pub id: u32,
    /// Logical x in screen coords (top-left origin, matches Quartz global space).
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// kCGWindowOwnerName, empty string if missing.
    pub app_name: String,
    /// kCGWindowName, empty string if missing (private-window-name entitlement
    /// is required for many windows, so this is often empty).
    pub title: String,
    /// kCGWindowLayer — 0 is the normal app window layer; higher = menubar,
    /// dock, status indicators, etc.
    pub layer: i32,
    /// kCGWindowAlpha — 0.0 fully transparent, 1.0 opaque.
    pub alpha: f64,
    /// kCGWindowOwnerPID.
    pub pid: i32,
}

/// App owner names that should never be reported as hoverable windows even
/// when CG happens to expose them. These are system UI surfaces that live on
/// layer 0 occasionally and would otherwise pollute the result list.
const IGNORED_APPS: &[&str] = &[
    "Dock",
    "Window Server",
    "Notification Center",
    "Control Center",
];

/// Read `key` from `dict` as a `CFNumber` and convert to `f64`. Returns None
/// if the key is missing or the value can't be coerced.
fn dict_f64(dict: &CFDictionary<CFString, CFType>, key_ref: core_foundation::string::CFStringRef) -> Option<f64> {
    let key = unsafe { CFString::wrap_under_get_rule(key_ref) };
    let v = dict.find(&key)?;
    let num = v.downcast::<CFNumber>()?;
    num.to_f64()
}

fn dict_i32(dict: &CFDictionary<CFString, CFType>, key_ref: core_foundation::string::CFStringRef) -> Option<i32> {
    let key = unsafe { CFString::wrap_under_get_rule(key_ref) };
    let v = dict.find(&key)?;
    let num = v.downcast::<CFNumber>()?;
    // Some CG keys (PID, layer) are stored as int64; fall back through i64 to i32.
    num.to_i32().or_else(|| num.to_i64().map(|n| n as i32))
}

fn dict_u32(dict: &CFDictionary<CFString, CFType>, key_ref: core_foundation::string::CFStringRef) -> Option<u32> {
    let key = unsafe { CFString::wrap_under_get_rule(key_ref) };
    let v = dict.find(&key)?;
    let num = v.downcast::<CFNumber>()?;
    num.to_i64().map(|n| n as u32)
}

fn dict_string(dict: &CFDictionary<CFString, CFType>, key_ref: core_foundation::string::CFStringRef) -> Option<String> {
    let key = unsafe { CFString::wrap_under_get_rule(key_ref) };
    let v = dict.find(&key)?;
    let s = v.downcast::<CFString>()?;
    Some(s.to_string())
}

fn dict_bool(dict: &CFDictionary<CFString, CFType>, key_ref: core_foundation::string::CFStringRef) -> Option<bool> {
    let key = unsafe { CFString::wrap_under_get_rule(key_ref) };
    let v = dict.find(&key)?;
    // CG stores this as a CFBoolean; CFBoolean isn't trivially downcastable in
    // 0.10 the same way numbers are, so fall back: a CFBoolean is also a
    // CFNumber-compatible 0/1 in most representations, but the safest path
    // is to compare the CFTypeRef against kCFBooleanTrue.
    unsafe {
        let ptr = v.as_CFTypeRef();
        extern "C" {
            static kCFBooleanTrue: CFTypeRef;
        }
        Some(ptr == kCFBooleanTrue)
    }
}

/// Parse a single CG window descriptor dict into a `WindowInfo`, applying
/// our filter rules. Returns None for any window we should not surface.
fn parse_entry(dict: &CFDictionary<CFString, CFType>, self_pid: i32) -> Option<WindowInfo> {
    // Bounds is itself a CFDictionary{X,Y,Width,Height}. Bail if missing or
    // malformed — a window with no rect is useless for hit-testing.
    let bounds_key = unsafe { CFString::wrap_under_get_rule(kCGWindowBounds) };
    let bounds_any = dict.find(&bounds_key)?;
    // ConcreteCFType is only implemented for the untyped CFDictionary; we
    // re-wrap it with explicit type params via wrap_under_get_rule below.
    let bounds_untyped = bounds_any.downcast::<CFDictionary>()?;
    let bounds: CFDictionary<CFString, CFType> = unsafe {
        CFDictionary::wrap_under_get_rule(bounds_untyped.as_concrete_TypeRef())
    };

    let x = dict_f64(&bounds, unsafe { ck("X") })?;
    let y = dict_f64(&bounds, unsafe { ck("Y") })?;
    let w = dict_f64(&bounds, unsafe { ck("Width") })?;
    let h = dict_f64(&bounds, unsafe { ck("Height") })?;

    let layer = dict_i32(dict, unsafe { kCGWindowLayer }).unwrap_or(i32::MAX);
    let alpha = dict_f64(dict, unsafe { kCGWindowAlpha }).unwrap_or(0.0);
    let pid = dict_i32(dict, unsafe { kCGWindowOwnerPID }).unwrap_or(0);
    let id = dict_u32(dict, unsafe { kCGWindowNumber }).unwrap_or(0);
    let app_name = dict_string(dict, unsafe { kCGWindowOwnerName }).unwrap_or_default();
    let title = dict_string(dict, unsafe { kCGWindowName }).unwrap_or_default();
    // kCGWindowIsOnscreen is only present for windows that *are* onscreen; if
    // the key is absent, treat as offscreen. CG with `OnScreenOnly` should
    // already filter, but belt-and-suspenders.
    let is_onscreen = dict_bool(dict, unsafe { kCGWindowIsOnscreen }).unwrap_or(false);

    // Filter rules — see module doc. Each line documents *why*.
    // layer 0 = normal app windows; menubar/dock/status indicators live higher.
    if layer != 0 { return None; }
    // Effectively-invisible windows confuse the hover highlight.
    if alpha <= 0.05 { return None; }
    if !is_onscreen { return None; }
    // Skip our own iShot windows so the overlay we display for the hover
    // affordance never gets reported as a target.
    if pid == self_pid { return None; }
    // Owner name occasionally missing for transient surfaces.
    if app_name.is_empty() { return None; }
    if IGNORED_APPS.iter().any(|n| *n == app_name) { return None; }
    // Tiny windows are almost always indicator dots / focus rings / shadows.
    if w < 60.0 || h < 60.0 { return None; }

    Some(WindowInfo { id, x, y, w, h, app_name, title, layer, alpha, pid })
}

/// Build a CFString for the literal bounds-sub-dict keys ("X", "Y", "Width",
/// "Height"). These aren't exposed as CG constants; the docs spell them out
/// as plain CFString literals. We leak the CFStringRef by passing ownership
/// to `wrap_under_get_rule` in the caller.
unsafe fn ck(s: &str) -> core_foundation::string::CFStringRef {
    // CFString::new returns an owned CFString; the caller's wrap_under_get_rule
    // bumps the retain, which we never release. To avoid leaking per-call,
    // construct the CFString here and leak its ref deliberately — there are
    // only four such keys ever needed, so the cost is fixed.
    let s = CFString::new(s);
    let r = s.as_concrete_TypeRef();
    std::mem::forget(s); // keep the underlying allocation alive
    r
}

/// Pure hit-test over a slice of windows assumed to be in front-to-back order.
/// Returns the first window whose rect contains the point.
fn hit_test<'a>(windows: &'a [WindowInfo], x: f64, y: f64) -> Option<&'a WindowInfo> {
    windows.iter().find(|w| {
        x >= w.x && x < w.x + w.w && y >= w.y && y < w.y + w.h
    })
}

/// Snapshot all currently on-screen, normal-layer, sufficiently-opaque
/// windows, in front-to-back z-order. Empty Vec if CG returns no data
/// (permission missing, transient race, etc.).
pub fn snapshot_windows() -> Vec<WindowInfo> {
    let self_pid = std::process::id() as i32;

    let array_ref: CFArrayRef = unsafe {
        CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            kCGNullWindowID,
        )
    };
    if array_ref.is_null() {
        return Vec::new();
    }

    // We received a +1 retain from a Copy* function; wrap so it's released
    // when the helper Vec we build goes out of scope. We don't use the typed
    // CFArray<T> wrapper because each element needs a manual dictionary cast.
    let count = unsafe { CFArrayGetCount(array_ref) };
    let mut out = Vec::with_capacity(count as usize);

    for i in 0..count {
        let value = unsafe { CFArrayGetValueAtIndex(array_ref, i) } as CFTypeRef;
        if value.is_null() { continue; }
        // The element is a +0 borrow inside the array; wrap_under_get_rule to
        // retain it for the lifetime of `dict`.
        let dict: CFDictionary<CFString, CFType> = unsafe {
            CFDictionary::wrap_under_get_rule(value as _)
        };
        if let Some(info) = parse_entry(&dict, self_pid) {
            out.push(info);
        }
    }

    // Balance the +1 retain from CGWindowListCopyWindowInfo.
    unsafe { core_foundation::base::CFRelease(array_ref as _); }

    out
}

/// Find the frontmost window containing the given logical screen point.
/// Caller is responsible for any caching/debouncing of repeated lookups.
pub fn find_window_at(x: f64, y: f64) -> Option<WindowInfo> {
    let windows = snapshot_windows();
    hit_test(&windows, x, y).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(id: u32, x: f64, y: f64, w: f64, h: f64) -> WindowInfo {
        WindowInfo {
            id, x, y, w, h,
            app_name: "Test".into(),
            title: format!("win{}", id),
            layer: 0,
            alpha: 1.0,
            pid: 1234,
        }
    }

    #[test]
    fn hit_test_returns_frontmost_overlapping_window() {
        // Front-to-back: front window fully covers point (50,50), middle
        // partially covers it, back covers it. Expect front to win.
        let windows = vec![
            mk(1, 0.0,   0.0,   100.0, 100.0), // front, covers (50,50)
            mk(2, 25.0,  25.0,  100.0, 100.0), // middle, also covers (50,50)
            mk(3, 0.0,   0.0,   200.0, 200.0), // back, covers everything
        ];
        let hit = hit_test(&windows, 50.0, 50.0).unwrap();
        assert_eq!(hit.id, 1);
    }

    #[test]
    fn hit_test_skips_non_containing_windows() {
        let windows = vec![
            mk(1, 0.0, 0.0, 10.0, 10.0),     // does not contain (50,50)
            mk(2, 40.0, 40.0, 100.0, 100.0), // contains (50,50)
        ];
        let hit = hit_test(&windows, 50.0, 50.0).unwrap();
        assert_eq!(hit.id, 2);
    }

    #[test]
    fn hit_test_returns_none_when_no_window_contains_point() {
        let windows = vec![
            mk(1, 0.0, 0.0, 10.0, 10.0),
            mk(2, 100.0, 100.0, 20.0, 20.0),
        ];
        assert!(hit_test(&windows, 500.0, 500.0).is_none());
    }

    #[test]
    fn hit_test_right_and_bottom_edges_are_exclusive() {
        // A window at (0,0) 100x100 contains (0,0) but NOT (100,100).
        let windows = vec![mk(1, 0.0, 0.0, 100.0, 100.0)];
        assert!(hit_test(&windows, 0.0, 0.0).is_some());
        assert!(hit_test(&windows, 99.999, 99.999).is_some());
        assert!(hit_test(&windows, 100.0, 50.0).is_none());
        assert!(hit_test(&windows, 50.0, 100.0).is_none());
    }
}
