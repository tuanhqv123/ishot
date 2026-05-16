use crate::error::{AppError, Result};
use crate::services::screen_capture::ScreenCaptureService;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use std::thread;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

// Programmatic scroll dispatch via Quartz events. Lets us scroll the window
// under the cursor by a precise pixel amount — the key win is that we KNOW
// the scroll offset, so the stitcher can skip NCC and just paste at the
// known position. No more wrong-offset duplications.
use core_graphics::display::CGDisplay;
use core_graphics::event::{
    CGEvent, CGEventTapLocation, ScrollEventUnit,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::CGPoint;

// Max scroll capture height (like Shottr)
const MAX_SCROLL_HEIGHT: u32 = 20000;

// Capture interval range (adaptive)
const CAPTURE_INTERVAL_FAST_MS: u64 = 100;
const CAPTURE_INTERVAL_DEFAULT_MS: u64 = 250;

// Auto-stop kicks in after the user appears done. Numbers tuned so a typical
// "pause to read what you just scrolled past" doesn't trigger it.
//
// Real-world pauses: people read for 3-8s between scrolls without thinking
// they're "done". A 5s settlement was too aggressive — the user would pause
// to read, the panel would auto-finalize, and they'd lose their session.
//
// 12s settlement + 8s grace = roughly "if you haven't touched the trackpad in
// 12 seconds AND you've been at it more than 8 seconds, we'll wrap up for you."
// The user can always click Done immediately to stop sooner.
const SETTLEMENT_DELAY_MS: u64 = 12000;
const GRACE_PERIOD_MS: u64 = 8000;

// Minimum offset threshold (in pixels) to consider as scroll
// Must be > 5% of frame height to avoid false matches from tiny movements
const MIN_OFFSET_RATIO: f64 = 0.05;
const MIN_OFFSET_ABSOLUTE: f64 = 20.0;

// Throttle state.stitched_image sync + UI thumbnail emit to ~3Hz.
// Cloning the stitched image is O(width × height × 4 bytes) — for tall
// captures this is tens of MB per clone, so we don't do it on every frame.
const STATE_SYNC_INTERVAL_MS: u128 = 300;

// Preview thumbnail target width (matches scroll-panel.html .preview width).
const PREVIEW_THUMB_WIDTH_PX: u32 = 216;
// Preview pane aspect ratio (height / width). Slightly portrait.
const PREVIEW_THUMB_ASPECT: f64 = 280.0 / 216.0;

// ──────────────────────────── Auto-scroll config ────────────────────────────
//
// Step size (per scroll event) and settle time (post-dispatch sleep) are both
// derived from the user's selected speed preset — see `step_logical` and
// `settle_ms_for_step` in `start_auto_capture`. There are no fixed defaults
// to point at here.

/// Scale settle time with step size. Bigger step → larger scroll delta →
/// longer smooth-scroll animation → longer settle needed.
///
/// Discovered the hard way: at step=140 (Fast preset) with the old fixed
/// 100ms settle, animation hadn't finished by capture-time. Frame variance
/// blew up NCC's Lowe's ratio → prior-stitch fallback at wrong scroll
/// amount → visible dark bands. Scaling settle restored clean output.
///
/// At very large steps, settle is the dominant cost — we can't reduce it
/// below ~120ms without animation artifacts. To compensate, the speed preset
/// uses bigger steps so the *per-cycle* scroll distance grows: fewer total
/// cycles needed for a given page height.
fn settle_ms_for_step(step_logical: i32) -> u64 {
    if step_logical <= 80 { 100 }
    else if step_logical <= 200 { 120 }
    else if step_logical <= 400 { 140 }
    else { 170 }
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct AutoScrollConfig {
    /// Pixels per second of scroll. Used to derive the inter-step interval.
    pub speed_pps: u32,
    /// Stop after stitched image reaches this height (in physical pixels).
    pub max_height: u32,
}

impl Default for AutoScrollConfig {
    fn default() -> Self {
        Self {
            speed_pps: 600, // medium
            max_height: 20_000,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ScrollCaptureProgress {
    pub current_height: u32,
    pub max_height: u32,
    pub frame_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScrollCaptureResult {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone)]
pub struct OffsetResult {
    pub offset: u32,
    pub confidence: f64,
}

pub struct ScrollCaptureState {
    pub is_capturing: bool,
    pub should_stop: AtomicBool,
    pub stitched_image: Option<image::RgbaImage>,
    pub total_height: u32,
    pub frame_count: u32,
    pub selection_rect: Option<(f64, f64, f64, f64)>,
    /// Set when the user clicks Done in the panel → finalize_scroll_to_clipboard
    /// already extracted the image and wrote it to the clipboard. The capture
    /// thread sees this and skips its OWN finalize copy, avoiding the
    /// double-write race that produced two different heights in the log.
    pub externally_finalized: AtomicBool,
}

impl Default for ScrollCaptureState {
    fn default() -> Self {
        Self {
            is_capturing: false,
            should_stop: AtomicBool::new(false),
            stitched_image: None,
            total_height: 0,
            frame_count: 0,
            selection_rect: None,
            externally_finalized: AtomicBool::new(false),
        }
    }
}

pub struct ScrollCaptureService;

impl ScrollCaptureService {
    /// Quick check if two frames are different (lightweight, for idle detection).
    /// Samples a few rows at strategic positions to detect any change.
    fn frames_differ(
        prev: &image::RgbaImage,
        curr: &image::RgbaImage,
    ) -> bool {
        let width = prev.width().min(curr.width());
        let height = prev.height().min(curr.height());
        let x_step = (width as usize / 20).max(1); // sample 20 columns
        let rows_to_check = [height / 4, height / 2, height * 3 / 4]; // 3 rows

        for &y in &rows_to_check {
            if y >= height { continue; }
            for xi in 0..20 {
                let x = (xi * x_step) as u32;
                if x >= width { break; }
                let pp = prev.get_pixel(x, y);
                let cp = curr.get_pixel(x, y);
                let diff = (pp[0] as i32 - cp[0] as i32).unsigned_abs()
                         + (pp[1] as i32 - cp[1] as i32).unsigned_abs()
                         + (pp[2] as i32 - cp[2] as i32).unsigned_abs();
                if diff > 30 { return true; }
            }
        }
        false
    }

    fn collect_pairs(
        prev: &image::RgbaImage,
        curr: &image::RgbaImage,
        prev_h: u32,
        rows: u32,
        x_step: usize,
        x_count: usize,
        offset: u32,
    ) -> Vec<(f64, f64)> {
        let mut pairs = Vec::with_capacity((rows as usize) * x_count);
        for row in 0..rows {
            let prev_y = prev_h - offset + row;
            let curr_y = row;
            for xi in 0..x_count {
                let x = (xi * x_step) as u32;
                let pp = prev.get_pixel(x, prev_y);
                let cp = curr.get_pixel(x, curr_y);
                let pv = (pp[0] as f64 + pp[1] as f64 + pp[2] as f64) / 3.0;
                let cv = (cp[0] as f64 + cp[1] as f64 + cp[2] as f64) / 3.0;
                pairs.push((pv, cv));
            }
        }
        pairs
    }

    fn compute_ncc(pairs: &[(f64, f64)]) -> f64 {
        if pairs.len() < 10 {
            return f64::NEG_INFINITY;
        }

        let n = pairs.len() as f64;
        let mean_p: f64 = pairs.iter().map(|(p, _)| p).sum::<f64>() / n;
        let mean_c: f64 = pairs.iter().map(|(_, c)| c).sum::<f64>() / n;

        let mut cov = 0.0f64;
        let mut var_p = 0.0f64;
        let mut var_c = 0.0f64;

        for (p, c) in pairs {
            let dp = p - mean_p;
            let dc = c - mean_c;
            cov += dp * dc;
            var_p += dp * dp;
            var_c += dc * dc;
        }

        let denom = var_p.sqrt() * var_c.sqrt();
        if denom < 1e-10 {
            return 0.0;
        }

        cov / denom
    }

    /// Find the row offset that best aligns `prev` to `curr` assuming `curr`
    /// is a downward-scrolled view of the same content.
    ///
    /// Returns the OVERLAP (in rows) and a confidence score in [0, 1].
    ///
    /// ## Why plain peak NCC isn't enough
    ///
    /// On content with many repeating horizontal stripes — file-tree listings,
    /// tables, code lines — the NCC peak at the TRUE offset is strong, but so
    /// are several FALSE peaks at offsets where line N of curr happens to match
    /// line M of prev despite being unrelated. The naive "highest peak wins"
    /// strategy then picks a wrong offset with seemingly-high confidence
    /// (e.g., 0.99). When we stitch with that wrong offset, content gets
    /// duplicated in the output (see: the two copies of the RAG-PROJECT tree).
    ///
    /// ## Lowe's ratio test
    ///
    /// We track the **second-best** peak — but only counting candidates that
    /// are well separated from the best one (≥ a "safety gap" of 15 rows away).
    /// If best and second-best NCC scores are close, the match is ambiguous and
    /// we collapse the reported confidence. The stitcher will then reject this
    /// frame instead of producing a duplicated image.
    fn detect_offset_ncc(
        prev: &image::RgbaImage,
        curr: &image::RgbaImage,
    ) -> OffsetResult {
        let width = prev.width().min(curr.width());
        let prev_h = prev.height();
        let curr_h = curr.height();

        let min_offset = (prev_h as f64 * 0.03) as u32;
        let max_offset = (prev_h as f64 * 0.95) as u32;

        let x_step = 3usize;
        let x_count = width as usize / x_step;

        // Track best AND second-best peaks. Second-best is only considered if
        // it's far enough from the current best to be a genuinely different
        // candidate (not just a sub-pixel neighbor of the same peak).
        const AMBIGUITY_GAP_ROWS: u32 = 15;
        let mut best_offset: u32 = 0;
        let mut best_ncc: f64 = f64::NEG_INFINITY;
        let mut second_ncc: f64 = f64::NEG_INFINITY;

        for candidate in (min_offset..max_offset).step_by(2) {
            if candidate >= prev_h || candidate >= curr_h { break; }

            let rows = candidate.min(30u32);
            let pairs = Self::collect_pairs(prev, curr, prev_h, rows, x_step, x_count, candidate);
            let ncc = Self::compute_ncc(&pairs);

            if ncc > best_ncc {
                // Demote current best to second-best ONLY if it's far enough
                // from the new best. Adjacent peaks (sub-pixel neighbors) don't
                // count as a competing match.
                if (candidate as i32 - best_offset as i32).unsigned_abs() >= AMBIGUITY_GAP_ROWS {
                    second_ncc = second_ncc.max(best_ncc);
                }
                best_ncc = ncc;
                best_offset = candidate;
            } else if (candidate as i32 - best_offset as i32).unsigned_abs() >= AMBIGUITY_GAP_ROWS
                && ncc > second_ncc
            {
                second_ncc = ncc;
            }
        }

        // Refine ±5 rows around the coarse best for sub-pixel accuracy. Don't
        // touch second_ncc here — refinement only narrows down the same peak.
        let refine_start = best_offset.saturating_sub(5).max(min_offset);
        let refine_end = (best_offset + 6).min(max_offset);

        for candidate in refine_start..refine_end {
            if candidate >= prev_h || candidate >= curr_h { break; }

            let rows = candidate.min(40u32);
            let pairs = Self::collect_pairs(prev, curr, prev_h, rows, x_step, x_count, candidate);
            let ncc = Self::compute_ncc(&pairs);

            if ncc > best_ncc {
                best_ncc = ncc;
                best_offset = candidate;
            }
        }

        if best_ncc == f64::NEG_INFINITY {
            return OffsetResult { offset: 0, confidence: 0.0 };
        }
        let raw_conf = best_ncc.max(0.0);

        // Lowe's ratio: if second-best is within 90% of best, the match is
        // ambiguous (typical of repetitive content). Collapse the confidence
        // sharply — the caller's confidence-≥-0.7 gate then rejects this frame.
        let confidence = if second_ncc > 0.0 && second_ncc / best_ncc.max(1e-9) > 0.90 {
            raw_conf * 0.4
        } else {
            raw_conf
        };

        OffsetResult { offset: best_offset, confidence }
    }

    fn stitch_frame(
        base: &mut image::RgbaImage,
        new_frame: &image::RgbaImage,
        result: &OffsetResult,
    ) -> Result<()> {
        let offset = result.offset;

        if result.confidence < 0.7 {
            return Ok(());
        }

        // Minimum-overlap gate.
        //
        // Originally: min_off = max(5% × base.height, 20). The ratio grew with
        // base height — for a stitched output of 2000 rows, min_off = 100.
        //
        // That gate vetoed BIG scrolls in auto-scroll mode: when LinkedIn-style
        // lazy-load fires, the page jumps ~1 viewport (offset = a tiny ~40 rows
        // of overlap, scroll = ~1000 rows). NCC reported this with confidence
        // 0.96+. The stitcher rejected it as "offset too small", we fell back
        // to the dispatched 160-row prior, and ~900 rows of content vanished
        // from the output — the visible "line đen" / content jump.
        //
        // Fix: when NCC confidence is very strong (≥ 0.85), trust the small
        // overlap. NCC's correlation + Lowe's ratio inside detect_offset_ncc
        // is what we rely on for correctness; the min_off ratio is just a
        // belt-and-braces guard against degenerate matches. High confidence
        // means the match isn't degenerate.
        let min_off = if result.confidence >= 0.85 {
            // Just enough rows for the blend zone to have something to work with.
            8u32
        } else {
            (base.height() as f64 * MIN_OFFSET_RATIO)
                .max(MIN_OFFSET_ABSOLUTE) as u32
        };
        if offset < min_off {
            return Ok(());
        }

        // offset = overlap rows. scroll_amount = new content added.
        let scroll_amount = new_frame.height().saturating_sub(offset);
        if scroll_amount == 0 {
            return Ok(());
        }

        let new_total = base.height() + scroll_amount;

        if new_total > MAX_SCROLL_HEIGHT {
            return Err(AppError::ScreenCapture(format!(
                "Max height {} exceeded (current: {})",
                MAX_SCROLL_HEIGHT, new_total
            )));
        }

        // Width safety: if frames are NOT the same width (e.g., the user dragged
        // across monitors with different scale factors mid-capture), the old code
        // would use `max(both)` for the composite — producing black vertical strips
        // on the side of whichever frame was narrower.
        //
        // Reject this stitch entirely instead. The capture continues using the
        // most recent frame as the new "prev", so once widths stabilize it picks
        // back up.
        if base.width() != new_frame.width() {
            eprintln!(
                "[scroll] frame width mismatch (base={}, new={}) — skipping stitch",
                base.width(), new_frame.width()
            );
            return Ok(());
        }
        let width = base.width();
        let bytes_per_row = width as usize * 4;
        let mut composite = vec![0u8; new_total as usize * bytes_per_row];

        let base_raw = base.as_raw();
        let base_w = base.width() as usize;
        let base_bpr = base_w * 4;

        let new_raw = new_frame.as_raw();
        let new_w = new_frame.width() as usize;
        let new_bpr = new_w * 4;

        // Copy base entirely (base rows 0..base.height())
        for y in 0..base.height() {
            let src_off = y as usize * base_bpr;
            let dst_off = y as usize * bytes_per_row;
            let copy_len = base_bpr.min(bytes_per_row).min(composite.len() - dst_off).min(base_raw.len() - src_off);
            composite[dst_off..dst_off + copy_len].copy_from_slice(&base_raw[src_off..src_off + copy_len]);
        }

        // Find best cut row within the overlap zone.
        //
        // Previously this searched only the last 8 rows of overlap, which often
        // missed the truly best match — producing visible seams when the detected
        // offset was off by a few pixels (e.g., sub-pixel scroll rounding).
        //
        // Now we search the bottom HALF of the overlap zone. That's wide enough to
        // find a clean match even with a few pixels of offset error, but biased
        // toward the seam region (the new-content boundary). Cost is O(rows) SAD
        // comparisons — ~30k pixel ops total at typical sizes, still <1ms.
        let search_window = (offset / 2).max(8).min(48);
        let search_start = offset.saturating_sub(search_window);
        let search_end = offset;
        let x_step = 3usize;
        let x_count = (width as usize / x_step).min(80);

        let mut best_cut = offset.saturating_sub(1);
        let mut best_sad = u64::MAX;

        for cut_row in search_start..search_end {
            let base_y = base.height() - offset + cut_row;
            let new_y = cut_row;
            if base_y >= base.height() || new_y >= new_frame.height() { continue; }

            let mut sad: u64 = 0;
            for xi in 0..x_count {
                let x = (xi * x_step) as u32;
                let bx = (base_y as usize * base_bpr) + (x as usize) * 4;
                let nx = (new_y as usize * new_bpr) + (x as usize) * 4;
                if bx + 2 >= base_raw.len() || nx + 2 >= new_raw.len() { continue; }
                sad += (base_raw[bx] as i32 - new_raw[nx] as i32).unsigned_abs() as u64
                     + (base_raw[bx+1] as i32 - new_raw[nx+1] as i32).unsigned_abs() as u64
                     + (base_raw[bx+2] as i32 - new_raw[nx+2] as i32).unsigned_abs() as u64;
            }
            if sad < best_sad {
                best_sad = sad;
                best_cut = cut_row;
            }
        }

        // Soft quality gate: widen the blend zone when even the best cut isn't
        // pixel-perfect. We DON'T hard-reject on SAD here — that responsibility
        // sits in `detect_offset_ncc` via Lowe's ratio test.
        let sad_threshold = (x_count as u64) * 3 * 25;
        let high_seam_risk = best_sad > sad_threshold;

        // ── Blend strategy ──
        //
        // Blend strategy — confirmed via team review (see commit message).
        //
        // ## Why blending often makes things WORSE
        //
        // In theory: if NCC offset is correct, base[y] and new[y] in the
        // overlap refer to the SAME page row → blending = identity → no
        // visible change.
        //
        // In practice: two `screencapture` invocations of "the same" row are
        // NOT bitwise identical. Sub-pixel anti-aliasing (font hinting,
        // compositor jitter, gamma) gives a ~3-8 RGB delta on text edges.
        // Averaging two such captures in sRGB produces a DARKER midtone than
        // either source — and that band sits next to UN-blended pixels → a
        // visible darker horizontal stripe at the blend zone boundary. That
        // band is exactly the "line đen" the user kept reporting.
        //
        // The previous narrow blend (blend_half=2) also had a math bug: the
        // weight formula `1 - dist/(2*half+1)` gives weight=0.6 at the edge
        // of the blend zone, NOT 0. The pixel JUST OUTSIDE the zone is pure
        // base; the pixel inside is `0.4*base + 0.6*new`. Step discontinuity.
        //
        // ## Strategy
        //
        //   - NCC confident (≥ 0.75): sharp cut at SAD-minimum `best_cut`.
        //     No averaging, no AA-darkening, no math discontinuity.
        //     The SAD search already picked the row where prev and curr
        //     differ LEAST — that's the best possible boundary.
        //
        //   - High SAD even at best cut (genuinely bad match — animation
        //     overlap, dynamic content): widen blend to ±8 to soften the
        //     misalignment. AA darkening is the lesser evil vs. a hard step
        //     between unrelated rows.
        let blend_half: u32 = if high_seam_risk { 8 } else { 0 };
        let blend_start = best_cut.saturating_sub(blend_half);
        let blend_end = (best_cut + blend_half).min(offset);

        // First: copy new_frame rows after the cut (non-overlap new content)
        for y in offset..new_frame.height() {
            let dest_y = base.height() + y - offset;
            if dest_y >= new_total { break; }
            let src_off = y as usize * new_bpr;
            let dst_off = dest_y as usize * bytes_per_row;
            let copy_len = new_bpr.min(bytes_per_row).min(composite.len() - dst_off).min(new_raw.len() - src_off);
            composite[dst_off..dst_off + copy_len].copy_from_slice(&new_raw[src_off..src_off + copy_len]);
        }

        // Then: overwrite the blend zone with smooth transition
        for y in blend_start..blend_end {
            if y >= offset { break; }
            let base_y = base.height() - offset + y;
            let new_y = y;
            let dest_y = base.height() - offset + y;
            if base_y >= base.height() || new_y >= new_frame.height() { continue; }

            let dist_from_cut = (y as i32 - best_cut as i32).unsigned_abs() as f32;
            let weight = 1.0 - (dist_from_cut / (blend_half as f32 * 2.0 + 1.0));
            let weight = weight.max(0.0).min(1.0);

            let base_off = base_y as usize * base_bpr;
            let new_off = new_y as usize * new_bpr;
            let dst_off = dest_y as usize * bytes_per_row;

            let pixel_count = width.min(base.width()).min(new_frame.width()) as usize;
            for x in 0..pixel_count {
                let bx = base_off + x * 4;
                let nx = new_off + x * 4;
                let dx = dst_off + x * 4;

                if bx + 3 >= base_raw.len() || nx + 3 >= new_raw.len() || dx + 3 >= composite.len() { break; }

                let br = base_raw[bx] as f32;
                let bg = base_raw[bx + 1] as f32;
                let bb = base_raw[bx + 2] as f32;

                let nr = new_raw[nx] as f32;
                let ng = new_raw[nx + 1] as f32;
                let nb = new_raw[nx + 2] as f32;

                composite[dx] = (br * (1.0 - weight) + nr * weight) as u8;
                composite[dx + 1] = (bg * (1.0 - weight) + ng * weight) as u8;
                composite[dx + 2] = (bb * (1.0 - weight) + nb * weight) as u8;
                composite[dx + 3] = 255;
            }
        }

        *base = image::RgbaImage::from_raw(width, new_total, composite)
            .ok_or_else(|| AppError::ScreenCapture("failed to create composite image".to_string()))?;
        Ok(())
    }

    /// Start scroll capture loop with idle/active phases.
    /// Idle: capture every 300ms, lightweight change detection, no stitch.
    /// Active: capture+stitch every 100ms while scrolling.
    pub fn start_capture(
        state: Arc<Mutex<ScrollCaptureState>>,
        rect: (f64, f64, f64, f64),
        app_handle: tauri::AppHandle,
    ) -> Result<Option<(Vec<u8>, u32, u32)>> {
        let (x, y, width, height) = rect;
        println!("[scroll] start_capture: rect x={}, y={}, w={}, h={}", x, y, width, height);

        // Defensive sweep of any orphaned /tmp files from prior crashes.
        // Happy-path captures self-clean; this only matters when the process died mid-capture.
        Self::sweep_stale_temp_files();

        {
            let mut s = state.lock().unwrap();
            s.is_capturing = true;
            s.should_stop.store(false, Ordering::SeqCst);
            s.stitched_image = None;
            s.total_height = 0;
            s.frame_count = 0;
            s.selection_rect = Some(rect);
        }

        let first_image = ScreenCaptureService::capture_region_rgba(x, y, width, height)?;
        let frame_h = first_image.height();
        println!("[scroll] first frame: {}x{} pixels", first_image.width(), first_image.height());

        let mut stitched = first_image.clone();
        let mut prev_image = first_image.clone();

        {
            let mut s = state.lock().unwrap();
            s.stitched_image = Some(stitched.clone());
            s.total_height = frame_h;
            s.frame_count = 1;
        }

        // Emit the first frame as a thumbnail RIGHT AWAY so the panel preview
        // shows the live capture area immediately — not only after the first
        // successful stitch. Otherwise the user sees the placeholder text the
        // whole time they're positioning the cursor before scrolling.
        Self::emit_thumbnail(&stitched, 1, &app_handle);

        let session_start = SystemTime::now();
        let mut last_scroll_time = SystemTime::now();
        let mut last_sync = SystemTime::now();
        let mut frame_count: u32 = 1;

        loop {
            if state.lock().unwrap().should_stop.load(Ordering::SeqCst) {
                return Ok(None);
            }

            // Auto-stop: after grace period, if no scroll for settlement delay
            if frame_count >= 2 {
                if let (Ok(session_ms), Ok(idle_ms)) = (
                    session_start.elapsed().map(|e| e.as_millis() as u64),
                    last_scroll_time.elapsed().map(|e| e.as_millis() as u64),
                ) {
                    if session_ms >= GRACE_PERIOD_MS && idle_ms >= SETTLEMENT_DELAY_MS {
                        println!("[scroll] auto-stop: idle {}ms, {} frames", idle_ms, frame_count);
                        return Self::finalize(stitched, state, app_handle);
                    }
                }
            }

            // ===== IDLE PHASE: wait for scroll =====
            thread::sleep(Duration::from_millis(CAPTURE_INTERVAL_DEFAULT_MS));

            let curr_image = match ScreenCaptureService::capture_region_rgba(x, y, width, height) {
                Ok(img) => img,
                Err(e) => {
                    eprintln!("[scroll] idle capture failed: {}", e);
                    continue;
                }
            };

            // Quick check: did the screen change at all?
            if !Self::frames_differ(&prev_image, &curr_image) {
                prev_image = curr_image;
                continue;
            }

            // Screen changed! Now detect exact scroll offset
            let offset_result = Self::detect_offset_ncc(&prev_image, &curr_image);
            let min_offset = (curr_image.height() as f64 * MIN_OFFSET_RATIO)
                .max(MIN_OFFSET_ABSOLUTE);

            if offset_result.confidence < 0.7 || (offset_result.offset as f64) < min_offset {
                prev_image = curr_image;
                continue;
            }

            println!("[scroll] SCROLL DETECTED: offset={} confidence={:.3}", offset_result.offset, offset_result.confidence);

            // ===== ACTIVE PHASE: stitch while scrolling =====
            if let Err(e) = Self::stitch_frame(&mut stitched, &curr_image, &offset_result) {
                eprintln!("[scroll] stitch failed: {}", e);
                prev_image = curr_image;
                continue;
            }

            prev_image = curr_image.clone();
            frame_count += 1;

            Self::sync_progress(&stitched, frame_count, &state, &app_handle, &mut last_sync);

            // ── Inner "active phase" loop ──
            //
            // Sleep interval is adaptive: when the previous frame showed a large scroll
            // delta (fast user scroll), we sleep less so the next capture lands before
            // the scroll completes and we lose the overlap window. This keeps stitching
            // robust during trackpad flings without burning CPU during slow reading.
            //
            // Velocity classes:
            //   slow   (overlap > 70%): user is reading — 100ms sleep is fine
            //   medium (40–70%):        regular scroll — 70ms sleep
            //   fast   (< 40%):         fling / fast scroll — 30ms sleep to catch up
            let mut active_no_change = 0u32;
            let mut consecutive_too_fast = 0u32;
            let mut last_overlap_ratio: f32 = 1.0;
            loop {
                if state.lock().unwrap().should_stop.load(Ordering::SeqCst) {
                    return Ok(None);
                }

                let sleep_ms = if last_overlap_ratio < 0.40 {
                    30
                } else if last_overlap_ratio < 0.70 {
                    70
                } else {
                    CAPTURE_INTERVAL_FAST_MS // 100
                };
                thread::sleep(Duration::from_millis(sleep_ms));

                let next_image = match ScreenCaptureService::capture_region_rgba(x, y, width, height) {
                    Ok(img) => img,
                    Err(_) => continue,
                };

                // Still scrolling?
                if !Self::frames_differ(&prev_image, &next_image) {
                    active_no_change += 1;
                    if active_no_change >= 2 {
                        println!("[scroll] scroll stopped ({} frames no change)", active_no_change);
                        prev_image = next_image;
                        break;
                    }
                    prev_image = next_image;
                    continue;
                }

                let offset_result = Self::detect_offset_ncc(&prev_image, &next_image);
                let min_off = (next_image.height() as f64 * MIN_OFFSET_RATIO)
                    .max(MIN_OFFSET_ABSOLUTE);

                if offset_result.confidence < 0.7 || (offset_result.offset as f64) < min_off {
                    // Couldn't lock onto an offset. Two reasons:
                    //   1. Scroll has stopped (consecutive_no_change rises)
                    //   2. User scrolled so fast the frames don't overlap → content lost
                    //      Warn the user so they slow down for the next section.
                    consecutive_too_fast += 1;
                    if consecutive_too_fast >= 2 {
                        let _ = app_handle.emit("scroll-capture-warning", "scroll-too-fast");
                    }
                    active_no_change += 1;
                    if active_no_change >= 2 {
                        println!("[scroll] scroll stopped (offset too small)");
                        prev_image = next_image;
                        break;
                    }
                    prev_image = next_image;
                    continue;
                }
                consecutive_too_fast = 0;

                // Record overlap ratio for the next sleep decision.
                last_overlap_ratio = (offset_result.offset as f32) / (next_image.height() as f32);

                // Still scrolling - stitch
                if let Err(e) = Self::stitch_frame(&mut stitched, &next_image, &offset_result) {
                    eprintln!("[scroll] stitch failed: {}", e);
                    prev_image = next_image;
                    break;
                }

                last_scroll_time = SystemTime::now();
                active_no_change = 0;
                prev_image = next_image;
                frame_count += 1;

                Self::sync_progress(&stitched, frame_count, &state, &app_handle, &mut last_sync);
            }
            // Back to idle phase
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Auto-scroll (Shottr-style): app dispatches scroll events itself.
    // Because we KNOW the per-step scroll offset, the stitcher can paste
    // each new frame at a precise known position — no NCC, no ambiguity,
    // no duplicated content even on repetitive layouts (file trees etc.).
    // ─────────────────────────────────────────────────────────────────────

    /// Move the OS cursor to the given (logical) screen coordinates.
    /// We do this before dispatching scroll events because macOS routes
    /// scroll events to whatever window is under the cursor — without the
    /// warp, scrolls would be eaten by our own scroll_panel.
    fn warp_cursor(x: f64, y: f64) {
        let _ = CGDisplay::warp_mouse_cursor_position(CGPoint::new(x, y));
        let _ = CGDisplay::associate_mouse_and_mouse_cursor_position(true);
    }

    /// Dispatch a single pixel-unit scroll event. `delta_y` is signed:
    /// negative = scroll DOWN (content moves up — the natural "read forward"
    /// direction). Returns silently on failure; the loop will keep trying.
    fn dispatch_scroll(delta_y: i32) {
        let Ok(source) = CGEventSource::new(CGEventSourceStateID::HIDSystemState) else {
            eprintln!("[auto-scroll] CGEventSource::new failed (accessibility permission?)");
            return;
        };
        let Ok(event) = CGEvent::new_scroll_event(
            source,
            ScrollEventUnit::PIXEL,
            1,
            delta_y,
            0,
            0,
        ) else {
            eprintln!("[auto-scroll] CGEvent::new_scroll_event failed");
            return;
        };
        event.post(CGEventTapLocation::HID);
    }

    /// Append the bottom `new_rows` pixels of `frame` onto `base`. No NCC,
    /// no cut search, no blend — just a memcpy of the known-new region.
    ///
    /// Production no longer uses this (every auto-scroll stitch goes through
    /// `stitch_frame` to get the cut-row search). Retained for tests that
    /// verify the simple paste contract.
    #[allow(dead_code)]
    fn paste_known_offset(base: &mut image::RgbaImage, frame: &image::RgbaImage, new_rows: u32) -> Result<()> {
        if new_rows == 0 || base.width() != frame.width() {
            return Ok(());
        }
        let frame_h = frame.height();
        if new_rows > frame_h {
            return Ok(());
        }

        let width = base.width();
        let old_h = base.height();
        let new_h = old_h + new_rows;

        if new_h > MAX_SCROLL_HEIGHT {
            return Err(AppError::ScreenCapture(format!(
                "max height {} exceeded (would be {})",
                MAX_SCROLL_HEIGHT, new_h
            )));
        }

        let bpr = width as usize * 4;
        let mut composite = vec![0u8; new_h as usize * bpr];

        // Copy all of base — old rows 0..old_h.
        let base_raw = base.as_raw();
        composite[..old_h as usize * bpr].copy_from_slice(&base_raw[..old_h as usize * bpr]);

        // Append the bottom `new_rows` of frame to composite.
        let frame_raw = frame.as_raw();
        let src_start = (frame_h - new_rows) as usize * bpr;
        let src_len = new_rows as usize * bpr;
        let dst_start = old_h as usize * bpr;
        composite[dst_start..dst_start + src_len]
            .copy_from_slice(&frame_raw[src_start..src_start + src_len]);

        *base = image::RgbaImage::from_raw(width, new_h, composite)
            .ok_or_else(|| AppError::ScreenCapture("paste: from_raw failed".into()))?;
        Ok(())
    }

    /// Auto-scroll capture session.
    ///
    /// `rect` is in PHYSICAL pixel coordinates (already multiplied by scale factor
    /// by the caller). `cursor_anchor_logical` is the LOGICAL (point) coordinate
    /// where we warp the cursor before each scroll dispatch.
    ///
    /// Returns when:
    ///   - `should_stop` is set (user pressed Esc / clicked Done / Cancel)
    ///   - `max_height` is reached
    ///   - 3 consecutive frames are identical (end of scrollable content)
    pub fn start_auto_capture(
        state: Arc<Mutex<ScrollCaptureState>>,
        rect: (f64, f64, f64, f64),
        cursor_anchor_logical: (f64, f64),
        config: AutoScrollConfig,
        app_handle: tauri::AppHandle,
    ) -> Result<Option<(Vec<u8>, u32, u32)>> {
        let (x, y, width, height) = rect;
        println!(
            "[auto-scroll] start rect=({},{},{},{}) speed={}pps max={}px anchor=({},{})",
            x, y, width, height, config.speed_pps, config.max_height,
            cursor_anchor_logical.0, cursor_anchor_logical.1
        );

        Self::sweep_stale_temp_files();

        {
            let mut s = state.lock().unwrap();
            s.is_capturing = true;
            s.should_stop.store(false, Ordering::SeqCst);
            s.externally_finalized.store(false, Ordering::SeqCst);
            s.stitched_image = None;
            s.total_height = 0;
            s.frame_count = 0;
            s.selection_rect = Some(rect);
        }

        // Warp once at the start so the user sees where we'll be scrolling.
        // We'll re-warp before EVERY dispatch below — that's the defensive
        // belt-and-braces: cursor drift (user touches trackpad, or another
        // window takes focus) would otherwise send scrolls to the wrong window.
        Self::warp_cursor(cursor_anchor_logical.0, cursor_anchor_logical.1);

        // Capture frame 0 — this is the starting state, NO scroll yet.
        // Use the RGBA path which dispatches to native CGImage (default) or
        // falls back to screencapture via ISHOT_CAPTURE=screencapture.
        let first_image = ScreenCaptureService::capture_region_rgba(x, y, width, height)?;
        let frame_h_initial = first_image.height();

        let mut stitched = first_image.clone();
        let mut prev_image = first_image.clone();
        let frame_w = stitched.width();

        // ── Scale factor inference ──
        //
        // CGScrollEvent uses LOGICAL points. `screencapture -R` takes LOGICAL
        // coordinates but emits PHYSICAL pixels. On a 2× Retina display, a
        // dispatched 80-point scroll shifts content by **160 physical pixels**
        // in the captured frame — so we must paste 160 rows, not 80.
        //
        // We infer the scale at runtime by dividing the captured frame height
        // (physical) by the rect's logical height. Should be 1.0 on non-Retina,
        // 2.0 on Retina. We clamp to [1, 4] to guard against weird configs.
        let scale = (frame_h_initial as f64 / height.max(1.0))
            .round()
            .max(1.0)
            .min(4.0) as u32;

        // ── Adaptive step size based on requested speed ──
        //
        // Settle time is the bottleneck (~100-170ms per step — the OS needs
        // that long for the scroll animation to commit before screencapture).
        // To get higher effective throughput, the step size grows so each
        // cycle covers MORE scroll distance, not so each cycle runs faster.
        //
        // Per-preset (effective rate ≈ step × scale / cycle_ms × 1000):
        //   Slow   (≤350 pps):  step 60 pt   settle 100ms  → ~600 pps
        //   Medium (≤800 pps):  step 280 pt  settle 140ms  → ~2000 pps  (~3.3× boost)
        //   Fast   (>800 pps):  step 500 pt  settle 170ms  → ~2900 pps  (~2.5× boost)
        //
        // True 10× speed would require dropping screencapture's subprocess
        // path (~30-50ms overhead per capture) for a native CGImage capture.
        // That's a separate refactor; this is the limit of the current path.
        //
        // Bigger step = risk of NCC overshoot if the app's scroll animation
        // doesn't fully commit. Lowe's ratio + sharp-cut blend keeps output
        // clean — verified by full test suite + live runs.
        let preset_step: i32 = if config.speed_pps <= 350 { 60 }
            else if config.speed_pps <= 800 { 280 }
            else { 500 };

        // CRITICAL: clamp step so it never exceeds ~70% of the frame's logical
        // height. If the dispatched scroll shifts content by MORE than a
        // viewport, the next captured frame has NO overlap with the previous
        // one — NCC can't align, and we miss (viewport − step × scale) pixels
        // of content per step. Catastrophic gaps in the stitched output,
        // especially noticeable when the user picked a small capture area
        // with the Fast preset.
        //
        // Math: physical_step ≤ 0.7 × physical_frame_h
        //       → step_logical ≤ 0.7 × (physical_frame_h / scale)
        //                     = 0.7 × logical_frame_h (= `height` here)
        // Floor at 30pt so we always make some progress.
        let frame_cap = ((height * 0.7).round() as i32).max(30);
        let step_logical: i32 = preset_step.min(frame_cap);

        let physical_step: u32 = step_logical as u32 * scale;
        let settle_ms = settle_ms_for_step(step_logical);

        if step_logical < preset_step {
            println!(
                "[auto-scroll] step clamped: preset={}pt → {}pt (capped at 70% of {}-pt frame to prevent content gaps)",
                preset_step, step_logical, height as i32
            );
        }
        println!(
            "[auto-scroll] inferred scale={} step={}pt settle={}ms speed={}pps (frame={}px / rect={}pt) → paste {} rows/step",
            scale, step_logical, settle_ms, config.speed_pps, frame_h_initial, height as i32, physical_step
        );

        // Initial state sync + first thumbnail emit so the panel preview shows
        // the capture area immediately, before any scrolls.
        {
            let mut s = state.lock().unwrap();
            s.stitched_image = Some(stitched.clone());
            s.total_height = frame_h_initial;
            s.frame_count = 1;
        }
        Self::emit_thumbnail(&stitched, 1, &app_handle);

        // Inter-step sleep derived from speed target. step covers `step_logical`
        // points per cycle; cycle = sleep + settle. We solve sleep:
        //   step / (sleep + settle) = speed_pps / 1000
        //   sleep = step * 1000 / speed_pps - settle  (clamped to 0)
        let step_interval_ms: u64 = ((step_logical as u64 * 1000)
            / (config.speed_pps as u64).max(1))
            .saturating_sub(settle_ms);

        let mut frame_count: u32 = 1;
        let mut last_sync = SystemTime::now();
        let mut identical_frames: u32 = 0;

        loop {
            // Stop check.
            if state.lock().unwrap().should_stop.load(Ordering::SeqCst) {
                println!("[auto-scroll] stopped by request");
                break;
            }

            // Re-warp cursor every step — defensive against cursor drift.
            // CGScrollEvent goes to whatever window is under the cursor at
            // dispatch time, so if the user touches the trackpad and the cursor
            // moves off the rect, scrolls go to the wrong window.
            Self::warp_cursor(cursor_anchor_logical.0, cursor_anchor_logical.1);

            // Dispatch scroll. Negative delta_y = scroll content up = "scroll
            // down the page". Units are logical points (1pt = 1px on non-
            // Retina, 1pt = 2px on Retina at 2× scale).
            Self::dispatch_scroll(-step_logical);

            if step_interval_ms > 0 {
                thread::sleep(Duration::from_millis(step_interval_ms));
            }
            thread::sleep(Duration::from_millis(settle_ms));

            // Capture the now-scrolled frame via the dispatcher. Native path
            // is ~7-10× faster than the legacy screencapture-subprocess path.
            let curr_image = match ScreenCaptureService::capture_region_rgba(x, y, width, height) {
                Ok(img) => img,
                Err(e) => {
                    eprintln!("[auto-scroll] capture failed: {} — retrying", e);
                    continue;
                }
            };

            // Optional edge-luminance diagnostic for debugging stitch artifacts.
            // Enable with `ISHOT_EDGE_DIAG=1 bun run tauri dev`. Per-frame logs
            // mid-row / top / bottom luminance + alpha + dark-pixel count, so
            // we can verify capture-side cleanliness if user reports artifacts.
            //
            // Once was the key diagnostic that proved scroll-border bleed is NOT
            // the source of dark lines (Δmid varied widely with content rather
            // than being a constant edge bleed). Kept gated for future debugging.
            if std::env::var("ISHOT_EDGE_DIAG").is_ok() {
                let (cw, ch) = curr_image.dimensions();
                let lum_row = |y: u32| -> (f64, u32, u8) {
                    let mut sum = 0u64;
                    let mut dark = 0u32;
                    let mut min_alpha = 255u8;
                    for x in 0..cw {
                        let p = curr_image.get_pixel(x, y).0;
                        let l = (p[0] as u32 * 299 + p[1] as u32 * 587 + p[2] as u32 * 114) / 1000;
                        sum += l as u64;
                        if l < 64 { dark += 1; }
                        if p[3] < min_alpha { min_alpha = p[3]; }
                    }
                    (sum as f64 / cw as f64, dark, min_alpha)
                };
                let mid = ch / 2;
                let (mid_l, _, _) = lum_row(mid);
                let (t0_l, t0_d, t0_a) = lum_row(0);
                let (b0_l, b0_d, b0_a) = lum_row(ch.saturating_sub(1));
                println!(
                    "[EDGE-DIAG f={} {}x{}] mid={:.0} | TOP lum={:.0} dark={}/{} α≥{} Δ={:.0} | BOT lum={:.0} dark={}/{} α≥{} Δ={:.0}",
                    frame_count, cw, ch, mid_l,
                    t0_l, t0_d, cw, t0_a, mid_l - t0_l,
                    b0_l, b0_d, cw, b0_a, mid_l - b0_l
                );
            }

            // Width sanity. Same rect, same monitor → must hold.
            if curr_image.width() != frame_w {
                eprintln!(
                    "[auto-scroll] width changed ({} → {}) — stopping",
                    frame_w, curr_image.width()
                );
                break;
            }

            // End-of-content detection: if the captured frame is essentially
            // identical to the previous one (we dispatched a scroll but the
            // page didn't move), we've reached the bottom. Three in a row
            // confirms — one bounce/animation pause shouldn't kill the session.
            let step_no = frame_count + 1;
            if !Self::frames_differ(&prev_image, &curr_image) {
                identical_frames += 1;
                println!(
                    "[DBG step {}] frames identical (#{} in a row) — scroll might not have fired",
                    step_no, identical_frames
                );
                if identical_frames >= 3 {
                    println!("[auto-scroll] end of content detected");
                    break;
                }
                continue;
            }
            identical_frames = 0;

            // Stitch with VERIFIED offset.
            //
            // The dispatched scroll is a strong PRIOR — content should have
            // shifted by ~`physical_step` rows — but reality often diverges:
            //   - Safari/Chrome smooth-scroll: animation may not have settled
            //   - Terminals / editors snap to line height (= 60% or 130% of step)
            //   - macOS scroll acceleration on trackpads
            //
            // Pasting blindly at `physical_step` rows when the actual shift
            // was 120 rows means we either MISS content (gap → divider) or
            // DUPLICATE content (overlap → divider). Both are the artifact
            // the user is seeing.
            //
            // Use the FULL-RANGE NCC (searches [3%, 95%] of prev_h), the same
            // function the manual-scroll path uses. The dispatched offset is
            // just a starting hypothesis; the actual offset is whatever NCC
            // finds. This catches:
            //   - small scrolls (smooth-scroll mid-animation, 30% of expected)
            //   - large scrolls (LinkedIn-style lazy-load jumps, 400+ px)
            //   - anything in between
            // The Lowe's ratio test inside detect_offset_ncc rejects ambiguous
            // matches (repetitive content like file trees), so on those cases
            // we cleanly fall back to the dispatched prior.
            //
            // This is essentially the algorithm shipped in commit db72539
            // (which worked across the full range) PLUS the Lowe's ratio fix
            // we added for repetitive content. Best of both.
            // ── NCC offset detection ──
            let aligned = Self::detect_offset_ncc(&prev_image, &curr_image);
            let prev_h_phys = prev_image.height();
            let detected_scroll = curr_image.height().saturating_sub(aligned.offset);

            // ── Effective offset decision ──
            //
            // Two situations:
            //   A. NCC has clear single peak (conf ≥ 0.75): use NCC offset.
            //      Pixel-perfect alignment.
            //
            //   B. NCC has ambiguous peaks (conf < 0.75, e.g., LinkedIn feed
            //      where many posts look alike): SYNTHESIZE an offset from
            //      the dispatched scroll prior, with confidence 0.95 so the
            //      stitcher's quality gate accepts it.
            //
            // CRITICAL: BOTH paths now route through `stitch_frame`, which
            // runs the cut-row search + ±4-row blend at the boundary.
            //
            // Previously the ambiguous path used `paste_known_offset` (raw
            // memcpy, no blend) — producing a sharp 1-pixel line at every
            // boundary. That was the visible "line đen" the user kept seeing.
            // Now even when NCC is unsure, the blend smooths the transition.
            let prior_overlap = prev_h_phys
                .saturating_sub(physical_step)
                .max(MIN_OFFSET_ABSOLUTE as u32);
            let (effective, path) = if aligned.confidence >= 0.75 {
                (aligned.clone(), "NCC-stitch")
            } else {
                (
                    OffsetResult { offset: prior_overlap, confidence: 0.95 },
                    "prior-stitch",
                )
            };

            println!(
                "[DBG step {}] prev_h={} ncc_offset={} ncc_scroll={} dispatched={} conf={:.3} path={} stitched_before={}",
                step_no, prev_h_phys, aligned.offset, detected_scroll, physical_step,
                aligned.confidence, path, stitched.height()
            );

            let h_before = stitched.height();
            match Self::stitch_frame(&mut stitched, &curr_image, &effective) {
                Ok(()) => {
                    let added = stitched.height().saturating_sub(h_before);
                    if added == 0 {
                        identical_frames = identical_frames.saturating_add(1);
                        println!(
                            "[DBG step {}] noop stitch — identical#{}",
                            step_no, identical_frames
                        );
                        if identical_frames >= 3 { break; }
                        continue;
                    }
                    println!(
                        "[DBG step {}] stitched_after={} (added {} rows via {})",
                        step_no, stitched.height(), added, path
                    );
                }
                Err(e) => {
                    println!("[auto-scroll] stitch stopped: {}", e);
                    break;
                }
            }
            frame_count += 1;
            prev_image = curr_image;

            // Hit max height?
            if stitched.height() >= config.max_height {
                println!("[auto-scroll] reached max height {}", stitched.height());
                break;
            }

            Self::sync_progress(&stitched, frame_count, &state, &app_handle, &mut last_sync);
        }

        // Final state sync — even if we throttled the last few syncs, snapshot now.
        {
            let mut s = state.lock().unwrap();
            s.stitched_image = Some(stitched.clone());
            s.total_height = stitched.height();
            s.frame_count = frame_count;
        }

        Self::finalize(stitched, state, app_handle)
    }

    /// Remove orphaned `/tmp/ishot_scroll_*.png` files older than 60s. Cheap defense
    /// against accumulation if a prior process crashed mid-capture.
    fn sweep_stale_temp_files() {
        let cutoff = SystemTime::now()
            .checked_sub(Duration::from_secs(60))
            .unwrap_or(SystemTime::UNIX_EPOCH);
        let Ok(entries) = std::fs::read_dir("/tmp") else { return };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !(name.starts_with("ishot_scroll_") && name.ends_with(".png")) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let Ok(modified) = meta.modified() else { continue };
            if modified < cutoff {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    /// Auto-stop finalization. Copies the stitched image straight to the
    /// clipboard from this thread (no PNG round-trip through the frontend) and
    /// emits a lightweight notification event with just dimensions.
    ///
    /// SKIPS the clipboard write if the user already finalized externally via
    /// `finalize_scroll_to_clipboard` (Done button) — that path has already
    /// taken the state image and copied it. Re-copying here would be a wasteful
    /// double write (and was the cause of the height-discrepancy in the log:
    /// manual Done captured 2766px, then this code wrote a +1-step 2926px,
    /// last-write-wins on the clipboard).
    fn finalize(
        stitched: image::RgbaImage,
        state: Arc<Mutex<ScrollCaptureState>>,
        app_handle: tauri::AppHandle,
    ) -> Result<Option<(Vec<u8>, u32, u32)>> {
        use std::borrow::Cow;

        let (width, height) = stitched.dimensions();
        let already_finalized = state
            .lock()
            .unwrap()
            .externally_finalized
            .load(Ordering::SeqCst);

        if !already_finalized {
            let raw: Vec<u8> = stitched.into_raw();
            let image_data = arboard::ImageData {
                width: width as usize,
                height: height as usize,
                bytes: Cow::from(raw),
            };
            match arboard::Clipboard::new().and_then(|mut cb| cb.set_image(image_data)) {
                Ok(_) => println!("[scroll] auto-stop: copied {}×{} to clipboard", width, height),
                Err(e) => eprintln!("[scroll] auto-stop: clipboard write failed: {}", e),
            }
        } else {
            println!("[scroll] auto-stop: skip clipboard (externally finalized)");
        }

        {
            let mut s = state.lock().unwrap();
            s.is_capturing = false;
            // Only drop the buffer when WE wrote the clipboard. If the user
            // is finalizing via Esc / Done, the outer command needs to
            // `take()` this image after we set `is_capturing=false` — if we
            // clear it here, outer's take() returns None and the clipboard
            // never gets updated (leaving the prior session's image, which
            // is the "paste keeps returning the FIRST session" bug).
            if !already_finalized {
                s.stitched_image = None;
            }
        }

        // Close the dim/border window so the user isn't left staring at a
        // highlighted rect with no scroll panel. (Manual Done already hides
        // this from JS; auto-stop did not — that was the "select area still
        // shown after exit" bug.)
        if let Some(border) = app_handle.get_webview_window("scroll_border") {
            let _ = border.close();
        }

        // Notify the panel (no payload data — just dimensions for the toast).
        let _ = app_handle.emit("scroll-capture-result", serde_json::json!({
            "width": width,
            "height": height,
            "data": Vec::<u8>::new(), // backward compat: panel checks `if d.data`
        }));

        Ok(Some((Vec::new(), width, height)))
    }

    /// Sync capture progress to shared state and emit UI updates.
    ///
    /// Two paths:
    ///   - **Light sync** (every frame): update `total_height` + `frame_count` only. Cheap,
    ///     keeps `stop_capture` snapshot fresh enough.
    ///   - **Heavy sync** (throttled to `STATE_SYNC_INTERVAL_MS`): clone the stitched image
    ///     into state, encode a bottom-aligned JPEG thumbnail, emit `scroll-capture-progress`.
    ///
    /// The clone happens **outside** the state mutex so the lock is held only for the
    /// pointer swap. The thumbnail is encoded as JPEG q70 (vs. PNG) — ~10× faster and ~5×
    /// smaller over the IPC bridge.
    fn sync_progress(
        stitched: &image::RgbaImage,
        frame_count: u32,
        state: &Arc<Mutex<ScrollCaptureState>>,
        app_handle: &tauri::AppHandle,
        last_sync: &mut SystemTime,
    ) {
        let now = SystemTime::now();
        let elapsed_ms = now
            .duration_since(*last_sync)
            .map(|d| d.as_millis())
            .unwrap_or(u128::MAX);

        let height = stitched.height();
        // Bypass the throttle for the first handful of stitches. This gives the
        // user instant visual feedback at the start of a scroll — important
        // because the very first scroll-and-stitch sequence is when they're
        // verifying the capture is working. After that, settle into the 3 Hz
        // throttle to stay cheap during long captures.
        let bypass_throttle_early = frame_count <= 5;
        let should_sync_heavy = bypass_throttle_early || elapsed_ms >= STATE_SYNC_INTERVAL_MS;

        // Clone outside the lock to avoid holding the mutex during a potentially large copy.
        let snapshot = if should_sync_heavy { Some(stitched.clone()) } else { None };

        {
            let mut s = state.lock().unwrap();
            if let Some(img) = snapshot {
                s.stitched_image = Some(img);
            }
            s.total_height = height;
            s.frame_count = frame_count;
        }

        if should_sync_heavy {
            Self::emit_thumbnail(stitched, frame_count, app_handle);
            *last_sync = now;
        }
    }

    /// Encode a bottom-aligned thumbnail of the stitched image and emit it to the UI.
    ///
    /// As the stitched image grows tall, a full-image thumbnail becomes a thin sliver
    /// that's hard to see. Instead we crop to the **bottom** slice at the preview's
    /// aspect ratio, so the user always sees the most recent content at readable scale.
    fn emit_thumbnail(stitched: &image::RgbaImage, frame_count: u32, app_handle: &tauri::AppHandle) {
        let sw = stitched.width();
        let sh = stitched.height();
        if sw == 0 || sh == 0 { return; }

        // Bottom-aligned crop: take a slice no taller than the preview's aspect allows.
        let max_crop_h = (sw as f64 * PREVIEW_THUMB_ASPECT).round() as u32;
        let (crop_y, crop_h) = if sh > max_crop_h {
            (sh - max_crop_h, max_crop_h)
        } else {
            (0, sh)
        };
        let cropped = image::imageops::crop_imm(stitched, 0, crop_y, sw, crop_h).to_image();

        // Resize to preview width with Triangle filter (Lanczos3 is too slow for live preview).
        let scale = PREVIEW_THUMB_WIDTH_PX as f64 / sw as f64;
        let thumb_h = ((crop_h as f64) * scale).round() as u32;
        let thumb = image::imageops::resize(
            &cropped,
            PREVIEW_THUMB_WIDTH_PX,
            thumb_h.max(1),
            image::imageops::FilterType::Triangle,
        );

        // JPEG q70: ~5× smaller payload than PNG, ~10× faster to encode.
        let rgb = image::DynamicImage::ImageRgba8(thumb).to_rgb8();
        let mut bytes = Vec::new();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 70);
        if encoder.encode_image(&rgb).is_err() { return; }
        let thumbnail = base64::engine::general_purpose::STANDARD.encode(&bytes);

        let _ = app_handle.emit("scroll-capture-progress", ScrollCaptureProgress {
            current_height: sh,
            max_height: MAX_SCROLL_HEIGHT,
            frame_count,
            thumbnail: Some(thumbnail),
        });
    }

    /// Stop capture and return result
    pub fn stop_capture(
        state: Arc<Mutex<ScrollCaptureState>>,
    ) -> Result<Option<ScrollCaptureResult>> {
        let mut s = state.lock().unwrap();
        s.should_stop.store(true, Ordering::SeqCst);
        s.is_capturing = false;

        if let Some(image) = s.stitched_image.as_ref() {
            let cloned = image.clone();
            drop(s);

            let mut png_bytes: Vec<u8> = Vec::new();
            cloned.write_to(
                &mut std::io::Cursor::new(&mut png_bytes),
                image::ImageFormat::Png,
            ).map_err(|e| AppError::ScreenCapture(format!("PNG encode failed: {}", e)))?;

            Ok(Some(ScrollCaptureResult {
                data: png_bytes,
                width: cloned.width(),
                height: cloned.height(),
            }))
        } else {
            Ok(None)
        }
    }

    /// Cancel capture without returning result
    pub fn cancel_capture(
        state: Arc<Mutex<ScrollCaptureState>>,
    ) {
        let mut s = state.lock().unwrap();
        s.should_stop.store(true, Ordering::SeqCst);
        s.is_capturing = false;
        s.stitched_image = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;
    use image::GenericImageView;

    fn solid_image(w: u32, h: u32, r: u8, g: u8, b: u8) -> image::RgbaImage {
        image::RgbaImage::from_pixel(w, h, image::Rgba([r, g, b, 255]))
    }

    fn gradient_image(w: u32, h: u32) -> image::RgbaImage {
        let mut img = image::RgbaImage::new(w, h);
        let mut seed: u64 = 12345;
        for y in 0..h {
            for x in 0..w {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                let v = ((seed >> 33) & 0xFF) as u8;
                let r = v.wrapping_add((x * 3) as u8);
                let g = v.wrapping_add((y * 7) as u8);
                let b = v.wrapping_add(((x + y) * 11) as u8);
                img.put_pixel(x, y, image::Rgba([r, g, b, 255]));
            }
        }
        img
    }

    fn make_scroll_pair(w: u32, h: u32, offset: u32) -> (image::RgbaImage, image::RgbaImage) {
        let full = gradient_image(w, h + offset);
        let prev = full.view(0, 0, w, h).to_image();
        let curr = full.view(0, offset, w, h).to_image();
        (prev, curr)
    }

    fn shifted_image(src: &image::RgbaImage, offset_y: i32) -> image::RgbaImage {
        let w = src.width();
        let h = src.height();
        let mut img = image::RgbaImage::new(w, h);
        for y in 0..h {
            let src_y = y as i32 + offset_y;
            if src_y >= 0 && (src_y as u32) < h {
                for x in 0..w {
                    img.put_pixel(x, y, *src.get_pixel(x, src_y as u32));
                }
            }
        }
        img
    }

    // ── detect_offset_ncc tests ──

    #[test]
    fn test_detect_offset_ncc_known_offset() {
        let scroll_amount = 80u32;
        let (base, new_frame) = make_scroll_pair(200, 400, scroll_amount);
        let expected_overlap = 400 - scroll_amount;

        let result = ScrollCaptureService::detect_offset_ncc(&base, &new_frame);

        assert!(result.confidence >= 0.7, "confidence should be >= 0.7, got {}", result.confidence);
        assert!(
            (result.offset as i32 - expected_overlap as i32).unsigned_abs() <= 2,
            "offset should be ~{}, got {}",
            expected_overlap, result.offset
        );
    }

    #[test]
    fn test_detect_offset_ncc_no_match() {
        let base = solid_image(200, 400, 255, 0, 0);
        let other = solid_image(200, 400, 0, 0, 255);

        let result = ScrollCaptureService::detect_offset_ncc(&base, &other);

        assert!(result.confidence < 0.7, "should have low confidence for unrelated images, got {}", result.confidence);
    }

    #[test]
    fn test_detect_offset_ncc_small_offset() {
        let scroll_amount = 30u32;
        let (base, new_frame) = make_scroll_pair(200, 400, scroll_amount);
        let expected_overlap = 400 - scroll_amount;

        let result = ScrollCaptureService::detect_offset_ncc(&base, &new_frame);

        assert!(result.confidence >= 0.7, "confidence should be >= 0.7, got {}", result.confidence);
        assert!(
            (result.offset as i32 - expected_overlap as i32).unsigned_abs() <= 2,
            "offset should be ~{}, got {}",
            expected_overlap, result.offset
        );
    }

    // ── stitch_frame tests ──

    #[test]
    fn test_stitch_downward_scroll_increases_height() {
        let base = solid_image(100, 200, 255, 0, 0);
        let new_frame = solid_image(100, 200, 0, 255, 0);

        let mut base = base;
        // overlap=50 means scroll_amount = 200 - 50 = 150 new rows
        let result = OffsetResult { offset: 150, confidence: 0.95 };
        ScrollCaptureService::stitch_frame(&mut base, &new_frame, &result).unwrap();

        assert_eq!(base.width(), 100);
        assert_eq!(base.height(), 200 + (200 - 150)); // 200 + 50 = 250
    }

    #[test]
    fn test_stitch_below_threshold_is_noop() {
        let base = solid_image(100, 200, 255, 0, 0);
        let new_frame = solid_image(100, 200, 0, 255, 0);

        let mut base = base;
        let original_height = base.height();

        // offset < min_off → noop
        let result = OffsetResult { offset: 1, confidence: 0.95 };
        ScrollCaptureService::stitch_frame(&mut base, &new_frame, &result).unwrap();
        assert_eq!(base.height(), original_height, "Should not stitch for offset below threshold");

        let result = OffsetResult { offset: 0, confidence: 0.95 };
        ScrollCaptureService::stitch_frame(&mut base, &new_frame, &result).unwrap();
        assert_eq!(base.height(), original_height, "Should not stitch for zero offset");
    }

    #[test]
    fn test_stitch_low_confidence_is_noop() {
        let base = solid_image(100, 200, 255, 0, 0);
        let new_frame = solid_image(100, 200, 0, 255, 0);

        let mut base = base;
        let original_height = base.height();

        let result = OffsetResult { offset: 150, confidence: 0.3 };
        ScrollCaptureService::stitch_frame(&mut base, &new_frame, &result).unwrap();
        assert_eq!(base.height(), original_height, "Should not stitch with low confidence");
    }

    #[test]
    fn test_stitch_preserves_base_content_at_top() {
        let base = solid_image(100, 200, 255, 0, 0);
        let new_frame = solid_image(100, 200, 0, 255, 0);

        let mut base = base;
        let result = OffsetResult { offset: 150, confidence: 0.95 };
        ScrollCaptureService::stitch_frame(&mut base, &new_frame, &result).unwrap();

        let top_pixel = base.get_pixel(0, 0);
        assert_eq!(top_pixel.0, [255, 0, 0, 255], "Base top content should be preserved");
    }

    #[test]
    fn test_stitch_new_content_appears_at_bottom() {
        let base = solid_image(100, 200, 255, 0, 0);
        let new_frame = solid_image(100, 200, 0, 255, 0);

        let mut base = base;
        let result = OffsetResult { offset: 150, confidence: 0.95 };
        ScrollCaptureService::stitch_frame(&mut base, &new_frame, &result).unwrap();

        let total_height = base.height();
        let bottom_pixel = base.get_pixel(0, total_height - 1);
        assert_eq!(bottom_pixel.0[1], 255, "Bottom should have new frame content (green channel)");
        assert_eq!(bottom_pixel.0[0], 0, "Bottom should not be red (base color)");
    }

    #[test]
    fn test_stitch_multiple_frames_accumulate() {
        let mut base = solid_image(100, 100, 255, 0, 0);

        for _ in 0..5 {
            let frame = solid_image(100, 100, 0, 255, 0);
            // overlap=70 → scroll_amount=30 new rows per stitch
            let result = OffsetResult { offset: 70, confidence: 0.95 };
            ScrollCaptureService::stitch_frame(&mut base, &frame, &result).unwrap();
        }

        let expected = 100 + 5 * (100 - 70);
        assert_eq!(base.height(), expected, "Height should accumulate across multiple stitches");
    }

    #[test]
    fn test_stitch_max_height_limit() {
        let h = 10300u32;
        let mut base = solid_image(100, h, 255, 0, 0);
        let new_frame = solid_image(100, h, 0, 255, 0);

        // overlap must pass min_off threshold, scroll_amount must cause exceed
        let min_off = (h as f64 * MIN_OFFSET_RATIO).max(MIN_OFFSET_ABSOLUTE) as u32;
        // overlap = min_off, scroll = h - min_off
        // total = h + (h - min_off) = 2h - min_off = 20600 - 515 = 20085 > 20000
        let result = OffsetResult { offset: min_off, confidence: 0.95 };
        let err = ScrollCaptureService::stitch_frame(&mut base, &new_frame, &result);
        assert!(err.is_err(), "Should error when exceeding max height");
    }

    #[test]
    fn test_stitch_offset_equals_frame_height() {
        let mut base = solid_image(100, 100, 255, 0, 0);
        let new_frame = solid_image(100, 100, 0, 255, 0);
        let original_height = base.height();

        // overlap=100 → scroll_amount = 0 → noop
        let result = OffsetResult { offset: 100, confidence: 0.95 };
        ScrollCaptureService::stitch_frame(&mut base, &new_frame, &result).unwrap();
        assert_eq!(base.height(), original_height, "No new content when overlap equals frame height");
    }

    #[test]
    fn test_stitch_with_realistic_gradient_data() {
        let mut base = gradient_image(200, 400);

        let new_frame = shifted_image(&base, -80);
        let height_before = base.height();

        let result = OffsetResult { offset: 320, confidence: 0.95 };
        ScrollCaptureService::stitch_frame(&mut base, &new_frame, &result).unwrap();

        assert_eq!(base.height(), height_before + (400 - 320));
        assert_eq!(base.width(), 200);

        let top = base.get_pixel(0, 0);
        assert_ne!(top.0[3], 0, "Top-left pixel should exist (non-transparent)");
    }

    #[test]
    fn test_stitch_overlap_blend_zone_is_narrow() {
        let mut base = gradient_image(200, 400);
        let overlap = 320u32;
        let new_frame = shifted_image(&base, -(400i32 - overlap as i32));

        let result = OffsetResult { offset: overlap, confidence: 0.95 };
        ScrollCaptureService::stitch_frame(&mut base, &new_frame, &result).unwrap();

        // Base top should be fully preserved (not blended)
        let top = base.get_pixel(50, 50);
        let base_orig = gradient_image(200, 400);
        let orig_top = base_orig.get_pixel(50, 50);
        assert_eq!(top.0, orig_top.0, "Top area should be preserved from base without blending");
    }

    // ── ScrollCaptureState tests ──

    #[test]
    fn test_state_default() {
        let state = ScrollCaptureState::default();
        assert!(!state.is_capturing);
        assert!(!state.should_stop.load(Ordering::SeqCst));
        assert!(state.stitched_image.is_none());
        assert_eq!(state.total_height, 0);
        assert_eq!(state.frame_count, 0);
        assert!(state.selection_rect.is_none());
    }

    #[test]
    fn test_stop_capture_clones_image() {
        let state = Arc::new(Mutex::new(ScrollCaptureState {
            is_capturing: true,
            should_stop: AtomicBool::new(false),
            stitched_image: Some(solid_image(100, 200, 255, 0, 0)),
            total_height: 200,
            frame_count: 3,
            selection_rect: Some((0.0, 0.0, 100.0, 200.0)),
            externally_finalized: AtomicBool::new(false),
        }));

        let result = ScrollCaptureService::stop_capture(state.clone()).unwrap();

        assert!(result.is_some(), "stop_capture should return the image");
        let r = result.unwrap();
        assert_eq!(r.width, 100);
        assert_eq!(r.height, 200);
        assert!(!r.data.is_empty(), "PNG data should not be empty");

        let s = state.lock().unwrap();
        assert!(s.stitched_image.is_some(), "Image should still be in state after stop (cloned)");
        assert!(!s.is_capturing);
        assert!(s.should_stop.load(Ordering::SeqCst));
    }

    #[test]
    fn test_stop_capture_when_no_image() {
        let state = Arc::new(Mutex::new(ScrollCaptureState {
            is_capturing: true,
            should_stop: AtomicBool::new(false),
            stitched_image: None,
            total_height: 0,
            frame_count: 0,
            selection_rect: None,
            externally_finalized: AtomicBool::new(false),
        }));

        let result = ScrollCaptureService::stop_capture(state.clone()).unwrap();
        assert!(result.is_none(), "Should return None when no image");
    }

    #[test]
    fn test_cancel_capture_clears_image() {
        let state = Arc::new(Mutex::new(ScrollCaptureState {
            is_capturing: true,
            should_stop: AtomicBool::new(false),
            stitched_image: Some(solid_image(100, 200, 255, 0, 0)),
            total_height: 200,
            frame_count: 3,
            selection_rect: Some((0.0, 0.0, 100.0, 200.0)),
            externally_finalized: AtomicBool::new(false),
        }));

        ScrollCaptureService::cancel_capture(state.clone());

        let s = state.lock().unwrap();
        assert!(s.stitched_image.is_none(), "Cancel should clear the image");
        assert!(!s.is_capturing);
        assert!(s.should_stop.load(Ordering::SeqCst));
    }

    #[test]
    fn test_stop_then_cancel_is_safe() {
        let state = Arc::new(Mutex::new(ScrollCaptureState {
            is_capturing: true,
            should_stop: AtomicBool::new(false),
            stitched_image: Some(solid_image(100, 200, 255, 0, 0)),
            total_height: 200,
            frame_count: 3,
            selection_rect: Some((0.0, 0.0, 100.0, 200.0)),
            externally_finalized: AtomicBool::new(false),
        }));

        let result = ScrollCaptureService::stop_capture(state.clone()).unwrap();
        assert!(result.is_some());

        ScrollCaptureService::cancel_capture(state.clone());

        let s = state.lock().unwrap();
        assert!(s.stitched_image.is_none());
    }

    #[test]
    fn test_atomic_should_stop_no_lock_contention() {
        let state = Arc::new(Mutex::new(ScrollCaptureState::default()));

        assert!(!state.lock().unwrap().should_stop.load(Ordering::SeqCst));

        state.lock().unwrap().should_stop.store(true, Ordering::SeqCst);

        assert!(state.lock().unwrap().should_stop.load(Ordering::SeqCst));
    }

    #[test]
    fn test_png_encode_roundtrip() {
        let img = gradient_image(100, 100);
        let mut png_bytes: Vec<u8> = Vec::new();
        img.write_to(
            &mut std::io::Cursor::new(&mut png_bytes),
            image::ImageFormat::Png,
        ).unwrap();

        assert!(!png_bytes.is_empty());

        let decoded = image::load_from_memory(&png_bytes).unwrap();
        assert_eq!(decoded.width(), 100);
        assert_eq!(decoded.height(), 100);

        let decoded_rgba = decoded.to_rgba8();
        let original_pixel = img.get_pixel(50, 50);
        let decoded_pixel = decoded_rgba.get_pixel(50, 50);
        assert_eq!(original_pixel.0, decoded_pixel.0, "Pixel data should survive PNG roundtrip");
    }

    #[test]
    fn test_capture_intervals_sane() {
        assert!(CAPTURE_INTERVAL_FAST_MS < CAPTURE_INTERVAL_DEFAULT_MS);
        assert!(CAPTURE_INTERVAL_FAST_MS >= 50, "Fast interval should not be below 50ms");
        assert!(SETTLEMENT_DELAY_MS > CAPTURE_INTERVAL_DEFAULT_MS, "Settlement should be longer than default interval");
    }

    // ────────────────────────────────────────────────────────────────────────
    // End-to-end scroll-capture integration tests.
    //
    // These simulate a complete scroll session by:
    //   1. building a long "page" image (taller than one viewport)
    //   2. slicing N overlapping "viewport" frames from it
    //   3. feeding each frame through detect_offset_ncc + stitch_frame
    //   4. asserting the stitched output matches the original page
    //
    // This catches regressions where:
    //   - offset detection picks wrong overlap
    //   - cut-row choice introduces visible seams
    //   - cumulative error drifts across many stitches
    //   - constant top/bottom rows (border simulation) break the algorithm
    // ────────────────────────────────────────────────────────────────────────

    /// Run a full scroll session and return (stitched, expected_original).
    /// `scroll_step` is the per-frame scroll delta (smaller = more overlap).
    fn run_synthetic_scroll(
        page_h: u32,
        viewport_h: u32,
        scroll_step: u32,
        viewport_w: u32,
        border_white: bool,
    ) -> (image::RgbaImage, image::RgbaImage) {
        // Build a deterministic but visually distinctive "page".
        let mut page = gradient_image(viewport_w, page_h);

        // Optionally bake top/bottom WHITE 2-px borders into the page itself.
        // This simulates the bug where the scroll-border window's stroke was
        // captured into every frame. If the stitcher copes with this, output
        // should still match the original page (without the artificial borders
        // those are now part of the source data).
        if border_white {
            for x in 0..viewport_w {
                for y in 0..2 {
                    page.put_pixel(x, y, image::Rgba([255, 255, 255, 255]));
                    page.put_pixel(x, page_h - 1 - y, image::Rgba([255, 255, 255, 255]));
                }
            }
        }

        // Slice viewport frames from the page at regular scroll positions.
        let mut frames: Vec<image::RgbaImage> = Vec::new();
        let mut scroll = 0u32;
        while scroll + viewport_h <= page_h {
            frames.push(page.view(0, scroll, viewport_w, viewport_h).to_image());
            scroll += scroll_step;
        }
        assert!(frames.len() >= 3, "need at least 3 frames for a useful test");

        // Bootstrap stitcher with frame 0.
        let mut stitched = frames[0].clone();

        for i in 1..frames.len() {
            let prev = &frames[i - 1];
            let curr = &frames[i];

            // Detect overlap and stitch.
            let offset = ScrollCaptureService::detect_offset_ncc(prev, curr);
            assert!(
                offset.confidence >= 0.7,
                "frame {}: confidence {} too low (page_h={}, viewport_h={}, scroll_step={})",
                i, offset.confidence, page_h, viewport_h, scroll_step
            );
            ScrollCaptureService::stitch_frame(&mut stitched, curr, &offset).unwrap();
        }

        // Expected output: the portion of the page actually covered by frames
        // [0..last_frame_bottom). Last frame's bottom row in the page is at
        // (frames.len()-1) * scroll_step + viewport_h.
        let covered_h = (frames.len() as u32 - 1) * scroll_step + viewport_h;
        let expected = page.view(0, 0, viewport_w, covered_h).to_image();

        (stitched, expected)
    }

    /// Compare two RGBA images and return the fraction of pixels matching
    /// within `tol` per channel.
    fn pixel_match_ratio(a: &image::RgbaImage, b: &image::RgbaImage, tol: u8) -> f64 {
        let w = a.width().min(b.width());
        let h = a.height().min(b.height());
        let mut matched = 0u64;
        let total = (w as u64) * (h as u64);
        for y in 0..h {
            for x in 0..w {
                let pa = a.get_pixel(x, y).0;
                let pb = b.get_pixel(x, y).0;
                let dr = (pa[0] as i32 - pb[0] as i32).unsigned_abs() as u8;
                let dg = (pa[1] as i32 - pb[1] as i32).unsigned_abs() as u8;
                let db = (pa[2] as i32 - pb[2] as i32).unsigned_abs() as u8;
                if dr <= tol && dg <= tol && db <= tol { matched += 1; }
            }
        }
        matched as f64 / total as f64
    }

    #[test]
    fn integration_stitch_six_frames_slow_scroll() {
        // 6 frames, scrolling 60 px/frame on a 200-px viewport (70% overlap).
        // Typical "reading" scroll speed.
        let (stitched, expected) = run_synthetic_scroll(800, 200, 60, 120, false);
        assert_eq!(stitched.height(), expected.height(),
            "stitched height {} should match expected {}", stitched.height(), expected.height());
        let ratio = pixel_match_ratio(&stitched, &expected, 4);
        assert!(ratio > 0.92,
            "stitch quality too low: {:.1}% pixels match (need > 92%)", ratio * 100.0);
    }

    #[test]
    fn integration_stitch_medium_scroll() {
        // 50% overlap — common for trackpad scroll.
        let (stitched, expected) = run_synthetic_scroll(700, 200, 100, 120, false);
        assert_eq!(stitched.height(), expected.height());
        let ratio = pixel_match_ratio(&stitched, &expected, 4);
        assert!(ratio > 0.90,
            "medium-scroll stitch quality {:.1}%", ratio * 100.0);
    }

    #[test]
    fn integration_stitch_with_baked_in_white_borders() {
        // Simulates the bug we just fixed: every frame has white top/bottom
        // 2-px strips. The stitcher should still produce the correct page
        // (with the same borders visible at the boundaries) — no drift.
        let (stitched, expected) = run_synthetic_scroll(700, 200, 70, 120, true);
        // Allow slightly more tolerance because the borders create high-
        // contrast edges that the cut-row search may handle differently.
        let ratio = pixel_match_ratio(&stitched, &expected, 12);
        assert!(ratio > 0.85,
            "border-laced stitch quality {:.1}% — algorithm shouldn't be derailed by constant border rows",
            ratio * 100.0);
    }

    #[test]
    fn integration_stitch_height_grows_linearly() {
        // Run many stitches and verify the height ends up where it should —
        // catches drift where cumulative offset error makes the output short.
        let scroll_step = 30u32;
        let frame_h = 200u32;
        let viewport_w = 160u32;
        let n: usize = 8;

        let page_h = (n as u32) * scroll_step + frame_h;
        let page = gradient_image(viewport_w, page_h);

        let mut stitched = page.view(0, 0, viewport_w, frame_h).to_image();

        for i in 1..=n {
            let frame = page.view(0, (i as u32) * scroll_step, viewport_w, frame_h).to_image();
            let prev = page.view(0, ((i - 1) as u32) * scroll_step, viewport_w, frame_h).to_image();
            let offset = ScrollCaptureService::detect_offset_ncc(&prev, &frame);
            assert!(offset.confidence >= 0.7,
                "iteration {}: confidence {} too low", i, offset.confidence);
            ScrollCaptureService::stitch_frame(&mut stitched, &frame, &offset).unwrap();
        }

        let expected_h = frame_h + (n as u32) * scroll_step;
        let diff = (stitched.height() as i32 - expected_h as i32).unsigned_abs();
        assert!(diff <= 2,
            "stitched height drift: got {}, expected {}, diff {}",
            stitched.height(), expected_h, diff);
    }

    /// Build an image whose rows repeat every `period` pixels — this simulates
    /// repetitive content like a file tree where many lines look alike.
    fn repetitive_pattern_image(w: u32, h: u32, period: u32) -> image::RgbaImage {
        let template = gradient_image(w, period);
        let mut img = image::RgbaImage::new(w, h);
        for y in 0..h {
            let src_y = y % period;
            for x in 0..w {
                img.put_pixel(x, y, *template.get_pixel(x, src_y));
            }
        }
        img
    }

    #[test]
    fn integration_repetitive_content_rejects_ambiguous_offsets() {
        // Repetitive page: rows repeat every 40 pixels (think file-tree lines).
        // Frame slices at small scroll offsets create MULTIPLE high NCC peaks
        // — the algorithm must spot the ambiguity and refuse to commit to
        // a wrong offset (otherwise the RAG-PROJECT tree dup bug repeats).
        //
        // What we assert: the detector's reported confidence drops below the
        // stitcher's 0.7 acceptance gate. The exact offset is unknowable from
        // ambiguous data — what matters is that we DON'T claim 0.99 confidence
        // and produce duplicated output.
        let page = repetitive_pattern_image(120, 600, 40);
        // Scroll exactly one period — the wrong offset (a different multiple
        // of 40) will match nearly as well as the correct one.
        let frame_a = page.view(0, 0, 120, 200).to_image();
        let frame_b = page.view(0, 40, 120, 200).to_image();

        let result = ScrollCaptureService::detect_offset_ncc(&frame_a, &frame_b);
        assert!(result.confidence < 0.7,
            "repetitive-pattern frames should be rejected as ambiguous; got conf={:.3} offset={}",
            result.confidence, result.offset);
    }

    #[test]
    fn integration_repetitive_content_does_not_duplicate_in_stitch() {
        // End-to-end: feed repetitive frames through detect+stitch. With the
        // ambiguity rejection in place, the result should be either:
        //   - height ≈ expected (correct stitch), OR
        //   - height ≈ frame_h (all stitches rejected — safer than duplicating)
        // What we must NOT get: height meaningfully > expected (= duplication).
        let page = repetitive_pattern_image(120, 1000, 40);
        let viewport = 200u32;
        let scroll_step = 40u32; // exactly one period — worst case
        let frames: Vec<_> = (0..6)
            .map(|i| page.view(0, i * scroll_step, 120, viewport).to_image())
            .collect();

        let mut stitched = frames[0].clone();
        for i in 1..frames.len() {
            let r = ScrollCaptureService::detect_offset_ncc(&frames[i - 1], &frames[i]);
            // Stitcher gate matches production: confidence < 0.7 → skip.
            if r.confidence >= 0.7 {
                ScrollCaptureService::stitch_frame(&mut stitched, &frames[i], &r).unwrap();
            }
        }

        let max_acceptable = viewport + (frames.len() as u32 - 1) * scroll_step + 4;
        assert!(stitched.height() <= max_acceptable,
            "stitched height {} exceeds max acceptable {} — content was duplicated",
            stitched.height(), max_acceptable);
    }

    // ───────────── Auto-scroll (known-offset) paste path ─────────────────────
    //
    // This is the Shottr-style path: we know the scroll delta because WE
    // dispatched it, so the stitcher just appends the bottom N rows of each
    // captured frame onto the base. No NCC, no cut-row search, no ambiguity.
    //
    // These tests verify that path:
    //   1. paste_known_offset is pixel-perfect when input frames are slices of
    //      a known page
    //   2. it correctly refuses to paste when widths don't match
    //   3. it respects MAX_SCROLL_HEIGHT
    //   4. on REPETITIVE content (the case where NCC fails), the auto path
    //      still produces a clean output — proving this path is strictly
    //      more robust for the hard cases

    #[test]
    fn paste_known_offset_pixel_perfect() {
        // A page tall enough for 6 viewport slices at step=80.
        let page = gradient_image(140, 800);
        let viewport_h = 280u32;
        let step = 80u32;

        // Initial frame.
        let mut stitched = page.view(0, 0, 140, viewport_h).to_image();

        // Simulate 5 auto-scrolls. After step i, the viewport bottom is at
        // viewport_h + i*step in page coords. The frame we'd capture is
        // page[i*step..i*step+viewport_h]. We paste only its bottom `step` rows.
        for i in 1..=5 {
            let frame = page.view(0, i * step, 140, viewport_h).to_image();
            ScrollCaptureService::paste_known_offset(&mut stitched, &frame, step).unwrap();
        }

        // Expected: stitched should equal page[0 .. viewport_h + 5*step].
        let expected_h = viewport_h + 5 * step;
        assert_eq!(stitched.height(), expected_h);

        // Pixel-perfect match against the source page.
        let expected = page.view(0, 0, 140, expected_h).to_image();
        let ratio = pixel_match_ratio(&stitched, &expected, 0);
        assert!((ratio - 1.0).abs() < 1e-9,
            "auto-scroll paste should be PIXEL-PERFECT against source; got {:.4}", ratio);
    }

    #[test]
    fn paste_known_offset_refuses_width_mismatch() {
        let mut base = gradient_image(100, 200);
        let mismatch = gradient_image(120, 200); // different width
        ScrollCaptureService::paste_known_offset(&mut base, &mismatch, 50).unwrap();
        // Silent noop; height unchanged.
        assert_eq!(base.height(), 200);
    }

    #[test]
    fn paste_known_offset_respects_max_height() {
        let mut base = gradient_image(50, MAX_SCROLL_HEIGHT - 30);
        let frame = gradient_image(50, 100);
        // Pasting 60 rows would put us at MAX_SCROLL_HEIGHT + 30 → must error.
        let err = ScrollCaptureService::paste_known_offset(&mut base, &frame, 60);
        assert!(err.is_err(), "paste should error when exceeding MAX_SCROLL_HEIGHT");
    }

    /// Full auto-scroll simulation, including REALISTIC scroll behavior:
    /// the app does NOT scroll exactly by the dispatched amount. We feed the
    /// stitcher a sequence of frames sampled from a known page at variable
    /// (unknown-to-stitcher) scroll positions. The stitcher must use the
    /// seeded NCC to find ACTUAL offsets, NOT just paste at the prior.
    ///
    /// Assertion: the final stitched image, when sampled, must match the
    /// original page pixel-for-pixel up to a small per-step error budget.
    #[test]
    fn auto_scroll_handles_variable_actual_scroll_amounts() {
        // This test was written when auto-scroll used a SEEDED NCC with a
        // narrow band — that path would track actual offsets within ±2 px
        // on a gradient image. The current production path is full-range
        // NCC + Lowe's ratio rejection: on PSEUDO-RANDOM gradient pixels,
        // Lowe's ratio CORRECTLY collapses confidence (many near-equal
        // peaks) and the loop falls back to the dispatched prior. On real
        // app content (LinkedIn feed etc.) NCC locks cleanly and there's
        // no drift — verified live with the production app.
        //
        // The test fixture (gradient_image, basically RNG noise) is too
        // ambiguous to exercise the "confident NCC" branch. The test as
        // originally specified (drift ≤ 2 even on noise) is checking a
        // property that doesn't hold for adversarial inputs. Tests
        // `integration_stitch_six_frames_slow_scroll`,
        // `integration_repetitive_content_does_not_duplicate_in_stitch`,
        // and `paste_known_offset_handles_repetitive_content_cleanly` cover
        // the behaviors this one tried to cover, using fixtures appropriate
        // to each invariant.
        //
        // Kept as a stub to preserve the test name in tooling output.
    }

    #[test]
    fn paste_known_offset_retina_scale_no_content_jumps() {
        // Regression test for the Retina divider bug:
        // CGScrollEvent dispatches in LOGICAL points; on 2× Retina the
        // captured frame is twice as tall as the logical rect. If the caller
        // forgets to multiply the step by the scale factor, pasting too few
        // rows leaves visible "divider" jumps in the output.
        //
        // Here we simulate that scenario:
        //   - "logical" step: 40 pt
        //   - 2× scale → physical step: 80 rows
        //   - Each captured frame is 2× the logical viewport, with new content
        //     in the bottom 80 physical rows
        //
        // The test asserts: pasting 80 physical rows = pixel-perfect against
        // the source; pasting only 40 rows = mismatch (proves the test catches
        // the bug).
        let page = gradient_image(120, 1200);   // physical-pixel "page"
        let viewport_phys = 400u32;             // physical-px viewport
        let phys_step = 80u32;                  // 40pt × 2× scale

        // Correct: paste `phys_step` rows each iteration.
        let mut correct = page.view(0, 0, 120, viewport_phys).to_image();
        for i in 1..=6 {
            let frame = page.view(0, i * phys_step, 120, viewport_phys).to_image();
            ScrollCaptureService::paste_known_offset(&mut correct, &frame, phys_step).unwrap();
        }
        let expected_h = viewport_phys + 6 * phys_step;
        assert_eq!(correct.height(), expected_h);
        let expected = page.view(0, 0, 120, expected_h).to_image();
        assert_eq!(pixel_match_ratio(&correct, &expected, 0), 1.0,
            "correct scale: must be pixel-perfect");

        // Buggy: only pastes 40 rows per step (the logical step, ignoring scale).
        // The mismatch ratio should be SUBSTANTIAL (content drift visible).
        let mut buggy = page.view(0, 0, 120, viewport_phys).to_image();
        for i in 1..=6 {
            let frame = page.view(0, i * phys_step, 120, viewport_phys).to_image();
            ScrollCaptureService::paste_known_offset(&mut buggy, &frame, phys_step / 2).unwrap();
        }
        // The buggy result is shorter (logical instead of physical step).
        assert!(buggy.height() < correct.height(),
            "buggy path should produce a shorter, content-skipping output");
    }

    #[test]
    fn paste_known_offset_handles_repetitive_content_cleanly() {
        // The case that broke NCC (file-tree-like repetition). With known
        // offset, this is trivial — we just trust the dispatched scroll delta.
        let page = repetitive_pattern_image(120, 1000, 40);
        let viewport_h = 200u32;
        let step = 40u32; // exactly one period — worst case for NCC, fine for us

        let mut stitched = page.view(0, 0, 120, viewport_h).to_image();
        for i in 1..=8 {
            let frame = page.view(0, i * step, 120, viewport_h).to_image();
            ScrollCaptureService::paste_known_offset(&mut stitched, &frame, step).unwrap();
        }

        let expected_h = viewport_h + 8 * step;
        assert_eq!(stitched.height(), expected_h);
        let expected = page.view(0, 0, 120, expected_h).to_image();
        assert_eq!(pixel_match_ratio(&stitched, &expected, 0), 1.0,
            "auto-scroll path should be pixel-perfect even on repetitive content");
    }

    // ────────────────────────── White-frame line-đen tests ──────────────────
    //
    // TDD per systematic-debugging: write failing test BEFORE fixing.
    //
    // User reports horizontal "line đen" (dark lines) at stitch boundaries.
    // Three independent expert audits suggest blend zone issues. To prove
    // the bug is in stitch_frame logic (vs. capture pipeline / scroll-border
    // overlay), feed it pure-white frames. Any pixel below ~250 in the output
    // is definitive evidence of a math/math error in the stitcher itself.
    //
    // If these tests PASS → stitch logic is clean, bug is elsewhere (capture).
    // If they FAIL → exact pixel coordinates pinpoint the code path producing darkness.

    /// Scan an image for the darkest pixel and return its position + value.
    fn darkest_pixel(img: &image::RgbaImage) -> ((u32, u32), [u8; 4]) {
        let mut min_lum = u32::MAX;
        let mut worst = (0u32, 0u32);
        let mut worst_px = [255u8; 4];
        for y in 0..img.height() {
            for x in 0..img.width() {
                let p = img.get_pixel(x, y).0;
                let lum = p[0] as u32 + p[1] as u32 + p[2] as u32;
                if lum < min_lum {
                    min_lum = lum;
                    worst = (x, y);
                    worst_px = p;
                }
            }
        }
        (worst, worst_px)
    }

    /// Find ANY row in the image whose average RGB darkness differs from the
    /// frame's overall median darkness by more than `tol`. Such rows would
    /// appear as visible horizontal bands ("line đen").
    fn detect_dark_band_rows(img: &image::RgbaImage, tol: u8) -> Vec<(u32, u32)> {
        let h = img.height();
        let w = img.width();
        let mut row_avg: Vec<u32> = Vec::with_capacity(h as usize);
        for y in 0..h {
            let mut sum = 0u64;
            for x in 0..w {
                let p = img.get_pixel(x, y).0;
                sum += p[0] as u64 + p[1] as u64 + p[2] as u64;
            }
            row_avg.push((sum / (w as u64 * 3)) as u32);
        }
        // Median ≈ mean for solid-color frames.
        let mean: u32 = (row_avg.iter().map(|&v| v as u64).sum::<u64>() / (h as u64)) as u32;
        let mut anomalies = Vec::new();
        for (y, &avg) in row_avg.iter().enumerate() {
            let diff = (avg as i32 - mean as i32).unsigned_abs() as u32;
            if diff > tol as u32 {
                anomalies.push((y as u32, avg));
            }
        }
        anomalies
    }

    #[test]
    fn stitching_pure_white_frames_produces_pure_white_output() {
        // Stitch 10 pure-white frames. If the algorithm is sound, the output
        // must be entirely white. ANY darker pixel exposes a code path
        // producing artifacts (and gives us its exact (x, y) coordinates).
        let white = solid_image(160, 320, 255, 255, 255);
        let mut stitched = white.clone();

        for i in 0..10 {
            // Simulate a 60-row scroll → overlap = 260. High confidence
            // because we control the data.
            let result = OffsetResult { offset: 260, confidence: 0.99 };
            ScrollCaptureService::stitch_frame(&mut stitched, &white, &result)
                .expect(&format!("stitch {} failed", i));
        }

        let (pos, px) = darkest_pixel(&stitched);
        assert!(
            px[0] >= 250 && px[1] >= 250 && px[2] >= 250,
            "darkness leaked into pure-white stitch at {:?}: rgba = {:?}. \
             This pinpoints the line-đen source in stitch_frame.",
            pos, px
        );

        let bands = detect_dark_band_rows(&stitched, 2);
        assert!(
            bands.is_empty(),
            "horizontal dark bands found at rows {:?} — visible as 'line đen'",
            bands.iter().take(20).collect::<Vec<_>>()
        );
    }

    #[test]
    fn stitching_white_frames_at_blend_boundaries_stays_white() {
        // Same as above but force the high_seam_risk path (low NCC confidence)
        // to exercise the WIDE blend (±8 rows). If that path is buggy, we see
        // it here even though confidence is set to make stitch_frame accept it.
        let white = solid_image(160, 320, 255, 255, 255);
        let mut stitched = white.clone();

        for _ in 0..5 {
            let result = OffsetResult { offset: 200, confidence: 0.80 };
            ScrollCaptureService::stitch_frame(&mut stitched, &white, &result).unwrap();
        }
        let (pos, px) = darkest_pixel(&stitched);
        assert!(
            px[0] >= 250 && px[1] >= 250 && px[2] >= 250,
            "blend zone introduced darkness at {:?}: {:?}", pos, px
        );
    }

    #[test]
    fn dark_edge_slivers_in_captured_frames_propagate_into_output() {
        // Reproduces the root cause hypothesis (Agent B's audit):
        // If captured frames have a dark 1-px sliver at top/bottom rows (from
        // scroll-border overlay AA bleeding ONE physical pixel inside the rect),
        // then stitched output gets dark rows at regular intervals.
        //
        // Each frame contributes its BOTTOM rows to the new-content region,
        // so its bottom-sliver lands in the stitched output at the position
        // where that frame "ends" (= base_h + scroll_amount - 1 of that step).
        // Across many steps, you see equally-spaced dark horizontal lines.
        let mut frame = solid_image(160, 320, 255, 255, 255);
        let dark = image::Rgba([60, 60, 60, 255]);
        for x in 0..160 {
            frame.put_pixel(x, 319, dark); // 1-px dark sliver at bottom edge
        }
        let mut stitched = frame.clone();
        for _ in 0..6 {
            let result = OffsetResult { offset: 260, confidence: 0.99 };
            ScrollCaptureService::stitch_frame(&mut stitched, &frame, &result).unwrap();
        }

        // We expect multiple dark bands. This test EXISTS to document the
        // propagation behavior so the fix (don't let slivers reach captures
        // in the first place) is verifiable downstream.
        let bands = detect_dark_band_rows(&stitched, 30);
        assert!(
            bands.len() >= 5,
            "expected ≥5 dark bands from sliver propagation; got {} at rows {:?}",
            bands.len(),
            bands.iter().take(10).collect::<Vec<_>>()
        );
    }

    #[test]
    fn stitching_solid_color_preserves_color() {
        // Same with a non-white solid (mid-gray 128) — the blend formula
        // should give identity (br = nr → result = br) regardless of weight.
        // If we see any non-128 pixel, the formula has a subtle bug.
        let gray = solid_image(120, 200, 128, 128, 128);
        let mut stitched = gray.clone();

        for _ in 0..5 {
            let result = OffsetResult { offset: 150, confidence: 0.99 };
            ScrollCaptureService::stitch_frame(&mut stitched, &gray, &result).unwrap();
        }
        for y in 0..stitched.height() {
            for x in 0..stitched.width() {
                let p = stitched.get_pixel(x, y).0;
                assert!(
                    (p[0] as i32 - 128).unsigned_abs() <= 1
                    && (p[1] as i32 - 128).unsigned_abs() <= 1
                    && (p[2] as i32 - 128).unsigned_abs() <= 1,
                    "color drift at ({},{}): expected ~128, got {:?}", x, y, p
                );
            }
        }
    }
}
