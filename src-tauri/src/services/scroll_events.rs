//! Listen-only scroll-wheel monitor.
//!
//! A session-level `CGEventTap` that observes the USER's real scroll-wheel
//! events and accumulates the exact pixel delta macOS applies (post-
//! acceleration — the same value AppKit's `scrollingDeltaY` reports). This gives
//! scroll capture a GROUND-TRUTH scroll offset instead of guessing it from image
//! correlation. Manual scrolling is unchanged — we only listen, never inject.
//!
//! Permission: a listen-only tap needs **Input Monitoring** (lighter than
//! Accessibility). We preflight + request it; if it isn't granted, the caller
//! falls back to the image-correlation path until the user grants it (which,
//! per macOS TCC, takes effect on the next app launch).
//!
//! Field constants verified against Apple's `CGEventTypes.h` / objc2-core-graphics:
//!   93 = kCGScrollWheelEventFixedPtDeltaAxis1 (sub-pixel pixels, accel applied)
//!   96 = kCGScrollWheelEventPointDeltaAxis1   (integer pixels, accel applied)

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use core_foundation::runloop::{kCFRunLoopDefaultMode, CFRunLoop};
use core_graphics::event::{
    CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
};

/// kCGScrollWheelEventPointDeltaAxis1 — integer PIXEL delta (accel applied).
const FIELD_POINT_DELTA_Y: u32 = 96;
/// kCGScrollWheelEventFixedPtDeltaAxis1 — sub-pixel PIXEL delta (accel applied).
const FIELD_FIXEDPT_DELTA_Y: u32 = 93;
/// kCGScrollWheelEventDeltaAxis1 — LINE delta. Some discrete mice report scroll
/// ONLY here (point/fixed read 0); scale to pixels so the accumulator advances.
const FIELD_LINE_DELTA_Y: u32 = 11;
/// Axis 2 = horizontal: same three fields, horizontal variants.
const FIELD_POINT_DELTA_X: u32 = 97;
const FIELD_FIXEDPT_DELTA_X: u32 = 94;
const FIELD_LINE_DELTA_X: u32 = 12;
/// Rough pixels-per-line for the line-delta fallback. Only used to TRIGGER a
/// capture (how far we've scrolled) — NCC refines the exact paste offset, so a
/// rough constant is fine.
const PIXELS_PER_LINE: f64 = 40.0;

// NOTE: a scroll-ONLY listen-only tap needs no TCC permission (Input Monitoring
// gates keyboard taps), so there is intentionally no preflight/request here.

struct Shared {
    start: Instant,
    /// Signed running sums of (vertical, horizontal) scroll, in pixels, since `start`.
    accumulated: Mutex<(f64, f64)>,
    /// Milliseconds (since `start`) of the most recent scroll event.
    last_event_ms: AtomicU64,
    /// Tap was disabled by the system (timeout / user input) — re-arm it.
    needs_reenable: AtomicBool,
}

/// Owns the tap thread. Dropping it stops the run loop and joins the thread.
pub struct ScrollMonitor {
    shared: Arc<Shared>,
    stop: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl ScrollMonitor {
    /// Start tapping. Returns `None` only if the tap genuinely couldn't be
    /// created.
    ///
    /// NOTE: a listen-only tap whose mask contains ONLY scroll-wheel events
    /// (no keyboard events) needs NO TCC permission on macOS — Input Monitoring
    /// gates keyboard observation, not mouse/scroll. So we do NOT preflight
    /// `CGPreflightListenEventAccess` (it's keyboard-broad and would force an
    /// unnecessary permission); we just create the tap and use it.
    pub fn start() -> Option<ScrollMonitor> {

        let shared = Arc::new(Shared {
            start: Instant::now(),
            accumulated: Mutex::new((0.0, 0.0)),
            last_event_ms: AtomicU64::new(0),
            needs_reenable: AtomicBool::new(false),
        });
        let stop = Arc::new(AtomicBool::new(false));

        let shared_thread = shared.clone();
        let stop_thread = stop.clone();
        let (ready_tx, ready_rx) = mpsc::channel::<bool>();

        let handle = thread::spawn(move || {
            // The tap + run loop must live entirely on THIS thread (they aren't
            // Send). The callback only reads 1-2 fields and updates the shared
            // accumulator, so it can never stall the tap (which would trip the
            // system's disable-by-timeout).
            let cb_shared = shared_thread.clone();
            let tap = CGEventTap::new(
                CGEventTapLocation::Session,
                CGEventTapPlacement::HeadInsertEventTap,
                CGEventTapOptions::ListenOnly,
                vec![CGEventType::ScrollWheel],
                move |_proxy, etype, event| {
                    match etype {
                        CGEventType::TapDisabledByTimeout
                        | CGEventType::TapDisabledByUserInput => {
                            cb_shared.needs_reenable.store(true, Ordering::SeqCst);
                        }
                        CGEventType::ScrollWheel => {
                            // Post-acceleration PIXEL delta. Trackpads / Magic Mouse
                            // populate point & fixed; a discrete wheel mouse may
                            // populate ONLY the line delta (point & fixed read 0) —
                            // scale that to pixels so the accumulator still advances.
                            // Without this, mouse-wheel scroll captured no frames.
                            let read_axis = |point_f: u32, fixed_f: u32, line_f: u32| -> f64 {
                                let point = event.get_double_value_field(point_f);
                                if point.abs() > 0.0001 {
                                    return point;
                                }
                                let fixed = event.get_double_value_field(fixed_f);
                                if fixed.abs() > 0.0001 {
                                    return fixed;
                                }
                                let lines = event.get_double_value_field(line_f);
                                if lines.abs() > 0.0001 {
                                    lines * PIXELS_PER_LINE
                                } else {
                                    0.0
                                }
                            };
                            let dy = read_axis(
                                FIELD_POINT_DELTA_Y, FIELD_FIXEDPT_DELTA_Y, FIELD_LINE_DELTA_Y,
                            );
                            let dx = read_axis(
                                FIELD_POINT_DELTA_X, FIELD_FIXEDPT_DELTA_X, FIELD_LINE_DELTA_X,
                            );
                            if dy != 0.0 || dx != 0.0 {
                                if let Ok(mut acc) = cb_shared.accumulated.lock() {
                                    acc.0 += dy;
                                    acc.1 += dx;
                                }
                                cb_shared.last_event_ms.store(
                                    cb_shared.start.elapsed().as_millis() as u64,
                                    Ordering::SeqCst,
                                );
                            }
                        }
                        _ => {}
                    }
                    // Listen-only: the return value is ignored, but the signature
                    // requires an Option<CGEvent>.
                    None
                },
            );

            let tap = match tap {
                Ok(t) => t,
                Err(_) => {
                    let _ = ready_tx.send(false);
                    return;
                }
            };
            let source = match tap.mach_port.create_runloop_source(0) {
                Ok(s) => s,
                Err(_) => {
                    let _ = ready_tx.send(false);
                    return;
                }
            };

            let mode = unsafe { kCFRunLoopDefaultMode };
            CFRunLoop::get_current().add_source(&source, mode);
            tap.enable();
            let _ = ready_tx.send(true);

            // Service the run loop in short slices so we can poll the stop flag
            // and re-arm the tap if the system disabled it.
            while !stop_thread.load(Ordering::SeqCst) {
                CFRunLoop::run_in_mode(mode, Duration::from_millis(150), false);
                if shared_thread.needs_reenable.swap(false, Ordering::SeqCst) {
                    tap.enable();
                }
            }
        });

        match ready_rx.recv_timeout(Duration::from_millis(2000)) {
            Ok(true) => Some(ScrollMonitor {
                shared,
                stop,
                handle: Some(handle),
            }),
            _ => {
                stop.store(true, Ordering::SeqCst);
                let _ = handle.join();
                None
            }
        }
    }

    /// Signed running sums of (vertical, horizontal) scroll, in pixels, since
    /// start. The capture loop only uses the DIFFERENCE between two reads, so
    /// the absolute origin doesn't matter.
    pub fn accumulated_xy(&self) -> (f64, f64) {
        *self.shared.accumulated.lock().unwrap()
    }

    /// Milliseconds since the most recent scroll event (large ⇒ scroll is idle).
    pub fn ms_since_last_event(&self) -> u64 {
        let now = self.shared.start.elapsed().as_millis() as u64;
        now.saturating_sub(self.shared.last_event_ms.load(Ordering::SeqCst))
    }
}

impl Drop for ScrollMonitor {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}
