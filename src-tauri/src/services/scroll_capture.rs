use crate::error::{AppError, Result};
use crate::services::screen_capture::ScreenCaptureService;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use std::thread;
use base64::Engine as _;
use serde::Serialize;
use tauri::Emitter;

// Max scroll capture height (like Shottr)
const MAX_SCROLL_HEIGHT: u32 = 20000;

// Capture interval range (adaptive)
const CAPTURE_INTERVAL_FAST_MS: u64 = 100;
const CAPTURE_INTERVAL_DEFAULT_MS: u64 = 250;

// Settlement delay after last scroll (5 seconds after grace period)
const SETTLEMENT_DELAY_MS: u64 = 5000;

// Grace period before auto-stop can trigger (gives user time to start scrolling)
const GRACE_PERIOD_MS: u64 = 10000;

// Minimum offset threshold (in pixels) to consider as scroll
// Must be > 5% of frame height to avoid false matches from tiny movements
const MIN_OFFSET_RATIO: f64 = 0.05;
const MIN_OFFSET_ABSOLUTE: f64 = 20.0;

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

        let mut best_offset: u32 = 0;
        let mut best_ncc: f64 = f64::NEG_INFINITY;

        for candidate in (min_offset..max_offset).step_by(2) {
            if candidate >= prev_h || candidate >= curr_h { break; }

            let rows = candidate.min(30u32);
            let pairs = Self::collect_pairs(prev, curr, prev_h, rows, x_step, x_count, candidate);
            let ncc = Self::compute_ncc(&pairs);

            if ncc > best_ncc {
                best_ncc = ncc;
                best_offset = candidate;
            }
        }

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

        let confidence = if best_ncc == f64::NEG_INFINITY { 0.0 } else { best_ncc.max(0.0) };

        OffsetResult {
            offset: best_offset,
            confidence,
        }
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

        let min_off = (base.height() as f64 * MIN_OFFSET_RATIO)
            .max(MIN_OFFSET_ABSOLUTE) as u32;
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

        let width = base.width().max(new_frame.width());
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

        // Find best cut row within overlap (row with smallest difference)
        let blend_zone = 8u32.min(offset / 2);
        let search_start = offset.saturating_sub(blend_zone);
        let search_end = offset;
        let x_step = 3usize;
        let x_count = (width as usize / x_step).min(60);

        let mut best_cut = offset;
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

        // Blend a small zone around the cut point (±4 rows)
        let blend_half = 4u32;
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

        {
            let mut s = state.lock().unwrap();
            s.is_capturing = true;
            s.should_stop.store(false, Ordering::SeqCst);
            s.stitched_image = None;
            s.total_height = 0;
            s.frame_count = 0;
            s.selection_rect = Some(rect);
        }

        let (first_data, _frame_w, frame_h) = ScreenCaptureService::capture_region(x, y, width, height)?;
        let first_image = image::load_from_memory(&first_data)
            .map_err(|e| AppError::ScreenCapture(format!("decode first frame: {}", e)))?
            .to_rgba8();
        println!("[scroll] first frame: {}x{} pixels", first_image.width(), first_image.height());

        let mut stitched = first_image.clone();
        let mut prev_image = first_image.clone();

        {
            let mut s = state.lock().unwrap();
            s.stitched_image = Some(stitched.clone());
            s.total_height = frame_h;
            s.frame_count = 1;
        }

        let session_start = SystemTime::now();
        let mut last_scroll_time = SystemTime::now();
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

            let (curr_data, _, _) = match ScreenCaptureService::capture_region(x, y, width, height) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("[scroll] idle capture failed: {}", e);
                    continue;
                }
            };

            let curr_image = image::load_from_memory(&curr_data)
                .map_err(|e| AppError::ScreenCapture(format!("decode: {}", e)))?
                .to_rgba8();

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

            {
                let mut s = state.lock().unwrap();
                s.stitched_image = Some(stitched.clone());
                s.total_height = stitched.height();
                s.frame_count = frame_count;
            }

            // Emit progress
            Self::emit_progress(&stitched, frame_count, &app_handle);

            // Keep capturing fast while scrolling
            let mut active_no_change = 0u32;
            loop {
                if state.lock().unwrap().should_stop.load(Ordering::SeqCst) {
                    return Ok(None);
                }

                thread::sleep(Duration::from_millis(CAPTURE_INTERVAL_FAST_MS));

                let (next_data, _, _) = match ScreenCaptureService::capture_region(x, y, width, height) {
                    Ok(r) => r,
                    Err(_) => continue,
                };

                let next_image = image::load_from_memory(&next_data)
                    .map_err(|e| AppError::ScreenCapture(format!("decode: {}", e)))?
                    .to_rgba8();

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
                    active_no_change += 1;
                    if active_no_change >= 2 {
                        println!("[scroll] scroll stopped (offset too small)");
                        prev_image = next_image;
                        break;
                    }
                    prev_image = next_image;
                    continue;
                }

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

                {
                    let mut s = state.lock().unwrap();
                    s.stitched_image = Some(stitched.clone());
                    s.total_height = stitched.height();
                    s.frame_count = frame_count;
                }

                Self::emit_progress(&stitched, frame_count, &app_handle);
            }
            // Back to idle phase
        }
    }

    fn finalize(
        stitched: image::RgbaImage,
        state: Arc<Mutex<ScrollCaptureState>>,
        app_handle: tauri::AppHandle,
    ) -> Result<Option<(Vec<u8>, u32, u32)>> {
        let mut png_bytes: Vec<u8> = Vec::new();
        stitched.write_to(
            &mut std::io::Cursor::new(&mut png_bytes),
            image::ImageFormat::Png,
        ).map_err(|e| AppError::ScreenCapture(format!("PNG encode: {}", e)))?;

        {
            let mut s = state.lock().unwrap();
            s.is_capturing = false;
        }

        let _ = app_handle.emit("scroll-capture-result", ScrollCaptureResult {
            data: png_bytes.clone(),
            width: stitched.width(),
            height: stitched.height(),
        });

        Ok(Some((png_bytes, stitched.width(), stitched.height())))
    }

    fn emit_progress(stitched: &image::RgbaImage, frame_count: u32, app_handle: &tauri::AppHandle) {
        let thumb_h = 400u32; // taller for better preview
        let thumb_w = (stitched.width() as f64 * (thumb_h as f64 / stitched.height() as f64)).round() as u32;
        let thumb = image::imageops::resize(stitched, thumb_w.max(1), thumb_h, image::imageops::FilterType::Lanczos3); // sharper
        let mut thumb_bytes = Vec::new();
        thumb.write_to(&mut std::io::Cursor::new(&mut thumb_bytes), image::ImageFormat::Png).ok();
        let thumbnail = base64::engine::general_purpose::STANDARD.encode(&thumb_bytes);

        let _ = app_handle.emit("scroll-capture-progress", ScrollCaptureProgress {
            current_height: stitched.height(),
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
}
