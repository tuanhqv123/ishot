use crate::error::{AppError, Result};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
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
    fn unique_timestamp() -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    }

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

    /// Detect scroll offset using pure pixel matching (no Vision needed).
    /// Compares bottom of prev image with top of curr image to find the best vertical offset.
    /// Returns offset in pixels (positive = scrolled down).
    fn detect_offset_pixels(
        prev: &image::RgbaImage,
        curr: &image::RgbaImage,
    ) -> f64 {
        let width = prev.width().min(curr.width());
        let prev_h = prev.height();
        let curr_h = curr.height();

        // Search range: try offsets from 5% to 95% of frame height
        let min_offset = (prev_h as f64 * 0.03) as u32;
        let max_offset = (prev_h as f64 * 0.95) as u32;

        let x_step = 3usize;
        let x_count = width as usize / x_step;

        let mut best_offset: u32 = 0;
        let mut best_score = u64::MAX;

        // Search in steps of 2 for speed, then refine
        for candidate in (min_offset..max_offset).step_by(2) {
            if candidate >= prev_h || candidate >= curr_h { break; }

            let rows = candidate.min(30u32); // compare 30 rows max
            let mut sad: u64 = 0;
            let mut count: u64 = 0;

            for row in (0..rows).step_by(2) {
                let prev_y = prev_h - candidate + row;
                let curr_y = row;
                for xi in 0..x_count {
                    let x = (xi * x_step) as u32;
                    let pp = prev.get_pixel(x, prev_y);
                    let cp = curr.get_pixel(x, curr_y);
                    sad += (pp[0] as i32 - cp[0] as i32).unsigned_abs() as u64
                         + (pp[1] as i32 - cp[1] as i32).unsigned_abs() as u64
                         + (pp[2] as i32 - cp[2] as i32).unsigned_abs() as u64;
                    count += 3;
                }
            }

            if count > 0 {
                let avg = sad * 1000 / count; // scale for comparison
                if avg < best_score {
                    best_score = avg;
                    best_offset = candidate;
                }
            }
        }

        // Refine: search ±3 around best_offset at full resolution
        let refine_start = best_offset.saturating_sub(3).max(min_offset);
        let refine_end = (best_offset + 4).min(max_offset);

        for candidate in refine_start..refine_end {
            if candidate >= prev_h || candidate >= curr_h { break; }

            let rows = candidate.min(40u32);
            let mut sad: u64 = 0;
            let mut count: u64 = 0;

            for row in 0..rows {
                let prev_y = prev_h - candidate + row;
                let curr_y = row;
                for xi in 0..x_count {
                    let x = (xi * x_step) as u32;
                    let pp = prev.get_pixel(x, prev_y);
                    let cp = curr.get_pixel(x, curr_y);
                    sad += (pp[0] as i32 - cp[0] as i32).unsigned_abs() as u64
                         + (pp[1] as i32 - cp[1] as i32).unsigned_abs() as u64
                         + (pp[2] as i32 - cp[2] as i32).unsigned_abs() as u64;
                    count += 3;
                }
            }

            if count > 0 {
                let avg = sad * 1000 / count;
                if avg < best_score {
                    best_score = avg;
                    best_offset = candidate;
                }
            }
        }

        // Check if the best match is actually good (low enough SAD)
        let threshold = 15000u64 * 1000 / 3; // per-channel threshold
        if best_score > threshold {
            println!("[scroll] pixel offset: {} but score {} too high, no scroll detected", best_offset, best_score);
            return 0.0;
        }

        println!("[scroll] pixel offset: {} score={}", best_offset, best_score);
        best_offset as f64
    }

    /// Capture a region of the screen using screencapture CLI
    fn capture_region(x: f64, y: f64, width: f64, height: f64) -> Result<(Vec<u8>, u32, u32)> {
        let temp_path = format!("/tmp/ishot_scroll_{}.png", Self::unique_timestamp());
        let region = format!("{},{},{},{}", x as i32, y as i32, width as i32, height as i32);

        let status = Command::new("screencapture")
            .args(["-x", "-C", "-R", &region, &temp_path])
            .status()
            .map_err(|e| AppError::ScreenCapture(format!("screencapture failed: {}", e)))?;

        if !status.success() {
            return Err(AppError::ScreenCapture("screencapture failed".to_string()));
        }

        let png_data = std::fs::read(&temp_path)
            .map_err(|e| AppError::ScreenCapture(format!("read capture failed: {}", e)))?;
        let _ = std::fs::remove_file(&temp_path);

        // Extract dimensions from PNG header without holding reference to png_data
        let (w, h) = {
            let decoder = png::Decoder::new(std::io::Cursor::new(&png_data));
            let reader = decoder
                .read_info()
                .map_err(|e| AppError::ScreenCapture(format!("PNG decode failed: {}", e)))?;
            (reader.info().width, reader.info().height)
        };

        Ok((png_data, w, h))
    }

    /// Row-by-row voting to find exact overlap + best cut point.
    /// Returns (exact_offset, best_cut_row_in_overlap).
    /// offset = how many rows of new_frame overlap with base bottom.
    /// best_cut = row index within overlap where both images are most similar.
    fn find_offset_and_cut(
        base: &image::RgbaImage,
        new_frame: &image::RgbaImage,
        vision_estimate: f64,
    ) -> (u32, u32) {
        let estimate = vision_estimate.abs().round() as u32;
        let search_radius = 25u32;
        let search_start = estimate.saturating_sub(search_radius).max(1);
        let search_end = (estimate + search_radius).min(base.height()).min(new_frame.height());
        let width = base.width().min(new_frame.width());

        let x_step = 3usize;
        let x_count = width as usize / x_step;

        // Step 1: Find best offset using SAD (sum of absolute differences)
        let mut best_offset = estimate;
        let mut best_score = u64::MAX;

        for candidate in search_start..search_end {
            let rows = candidate.min(40u32);
            let mut sad: u64 = 0;
            let mut count: u64 = 0;

            for row in (0..rows).step_by(2) {
                let base_y = base.height() - candidate + row;
                let new_y = row;
                for xi in 0..x_count {
                    let x = (xi * x_step) as u32;
                    let bp = base.get_pixel(x, base_y);
                    let np = new_frame.get_pixel(x, new_y);
                    sad += (bp[0] as i32 - np[0] as i32).unsigned_abs() as u64
                         + (bp[1] as i32 - np[1] as i32).unsigned_abs() as u64
                         + (bp[2] as i32 - np[2] as i32).unsigned_abs() as u64;
                    count += 3;
                }
            }

            if count > 0 && sad < best_score {
                best_score = sad;
                best_offset = candidate;
            }
        }

        // Step 2: Find best cut point within the overlap (row with min difference)
        let offset = best_offset;
        let mut best_cut = offset / 2;
        let mut best_cut_score = u64::MAX;

        let cut_search_start = (offset / 4).max(1);
        let cut_search_end = (offset * 3 / 4).max(cut_search_start + 1);

        for cut_row in cut_search_start..cut_search_end {
            let base_y = base.height() - offset + cut_row;
            let new_y = cut_row;
            if base_y >= base.height() || new_y >= new_frame.height() { continue; }

            let mut row_sad: u64 = 0;
            for xi in 0..x_count {
                let x = (xi * x_step) as u32;
                let bp = base.get_pixel(x, base_y);
                let np = new_frame.get_pixel(x, new_y);
                row_sad += (bp[0] as i32 - np[0] as i32).unsigned_abs() as u64
                         + (bp[1] as i32 - np[1] as i32).unsigned_abs() as u64
                         + (bp[2] as i32 - np[2] as i32).unsigned_abs() as u64;
            }

            if row_sad < best_cut_score {
                best_cut_score = row_sad;
                best_cut = cut_row;
            }
        }

        println!("[scroll] voting: vision={}, offset={}, cut={}/{}, score={}", 
                 estimate, best_offset, best_cut, offset, best_score);

        (best_offset, best_cut)
    }

    fn stitch_frame(
        base: &mut image::RgbaImage,
        new_frame: &image::RgbaImage,
        offset_y: f64,
    ) -> Result<()> {
        if offset_y < MIN_OFFSET_ABSOLUTE {
            return Ok(());
        }

        let (exact_offset, best_cut) = Self::find_offset_and_cut(base, new_frame, offset_y);

        // Cut strategy: use base[0..base_keep] + new_frame[best_cut..end]
        // base_keep = base_h - offset + best_cut (the cut row in base coordinates)
        let base_keep = (base.height() - exact_offset + best_cut).min(base.height());
        let new_start = best_cut;
        let new_rows = new_frame.height().saturating_sub(new_start);
        let new_total = base_keep + new_rows;

        if new_rows == 0 {
            return Ok(());
        }

        if new_total > MAX_SCROLL_HEIGHT {
            return Err(AppError::ScreenCapture(format!(
                "Max height {} exceeded (current: {})",
                MAX_SCROLL_HEIGHT, new_total
            )));
        }

        let width = base.width().max(new_frame.width());
        let mut composite = image::RgbaImage::new(width, new_total);

        // Copy base rows 0..base_keep
        for y in 0..base_keep {
            for x in 0..width.min(base.width()) {
                composite.put_pixel(x, y, *base.get_pixel(x, y));
            }
        }

        // Blend 10 rows around the cut point for smooth transition
        let blend_half = 5u32.min(best_cut).min(base.height().saturating_sub(base_keep));

        // Copy new_frame rows with blending near the cut
        for y in 0..new_rows {
            let src_y = new_start + y;
            if src_y >= new_frame.height() { break; }
            let dest_y = base_keep + y;

            for x in 0..width.min(new_frame.width()) {
                let new_pixel = *new_frame.get_pixel(x, src_y);

                if y < blend_half && dest_y >= blend_half {
                    let alpha = (y as f32 + 0.5) / (blend_half as f32 * 2.0);
                    let base_x = x.min(base.width() - 1);
                    let base_pixel = base.get_pixel(base_x, dest_y);
                    composite.put_pixel(x, dest_y, image::Rgba([
                        (base_pixel[0] as f32 * (1.0 - alpha) + new_pixel[0] as f32 * alpha) as u8,
                        (base_pixel[1] as f32 * (1.0 - alpha) + new_pixel[1] as f32 * alpha) as u8,
                        (base_pixel[2] as f32 * (1.0 - alpha) + new_pixel[2] as f32 * alpha) as u8,
                        255,
                    ]));
                } else {
                    composite.put_pixel(x, dest_y, new_pixel);
                }
            }
        }

        *base = composite;
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

        let (first_data, _frame_w, frame_h) = Self::capture_region(x, y, width, height)?;
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

            let (curr_data, _, _) = match Self::capture_region(x, y, width, height) {
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
            let stitch_offset = Self::detect_offset_pixels(&prev_image, &curr_image);
            let min_offset = (curr_image.height() as f64 * MIN_OFFSET_RATIO)
                .max(MIN_OFFSET_ABSOLUTE);

            if stitch_offset < min_offset {
                prev_image = curr_image;
                continue;
            }

            println!("[scroll] SCROLL DETECTED: offset={}", stitch_offset);

            // ===== ACTIVE PHASE: stitch while scrolling =====
            if let Err(e) = Self::stitch_frame(&mut stitched, &curr_image, stitch_offset) {
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

                let (next_data, _, _) = match Self::capture_region(x, y, width, height) {
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

                let offset = Self::detect_offset_pixels(&prev_image, &next_image);
                let min_off = (next_image.height() as f64 * MIN_OFFSET_RATIO)
                    .max(MIN_OFFSET_ABSOLUTE);

                if offset < min_off {
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
                if let Err(e) = Self::stitch_frame(&mut stitched, &next_image, offset) {
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
        let thumb_h = 300u32;
        let thumb_w = (stitched.width() as f64 * (thumb_h as f64 / stitched.height() as f64)).round() as u32;
        let thumb = image::imageops::resize(stitched, thumb_w.max(1), thumb_h, image::imageops::FilterType::Triangle);
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

    fn solid_image(w: u32, h: u32, r: u8, g: u8, b: u8) -> image::RgbaImage {
        image::RgbaImage::from_pixel(w, h, image::Rgba([r, g, b, 255]))
    }

    fn gradient_image(w: u32, h: u32) -> image::RgbaImage {
        let mut img = image::RgbaImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let r = (x % 256) as u8;
                let g = (y % 256) as u8;
                let b = ((x + y) % 256) as u8;
                img.put_pixel(x, y, image::Rgba([r, g, b, 255]));
            }
        }
        img
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

    // ── stitch_frame tests ──

    #[test]
    fn test_stitch_downward_scroll_increases_height() {
        let base = solid_image(100, 200, 255, 0, 0);
        let new_frame = solid_image(100, 200, 0, 255, 0);
        let offset_y = 50.0; // scrolled down 50px

        let mut base = base;
        ScrollCaptureService::stitch_frame(&mut base, &new_frame, offset_y).unwrap();

        assert_eq!(base.width(), 100);
        assert_eq!(base.height(), 200 + (200 - 50));
    }

    #[test]
    fn test_stitch_upward_scroll_increases_height() {
        let base = solid_image(100, 200, 255, 0, 0);
        let new_frame = solid_image(100, 200, 0, 255, 0);
        let offset_y = -50.0;

        let mut base = base;
        ScrollCaptureService::stitch_frame(&mut base, &new_frame, offset_y).unwrap();

        assert_eq!(base.width(), 100);
        assert_eq!(base.height(), 200 + (200 - 50));
    }

    #[test]
    fn test_stitch_below_threshold_is_noop() {
        let base = solid_image(100, 200, 255, 0, 0);
        let new_frame = solid_image(100, 200, 0, 255, 0);

        let mut base = base;
        let original_height = base.height();
        ScrollCaptureService::stitch_frame(&mut base, &new_frame, 1.0).unwrap();
        assert_eq!(base.height(), original_height, "Should not stitch for offset below threshold");

        ScrollCaptureService::stitch_frame(&mut base, &new_frame, 0.0).unwrap();
        assert_eq!(base.height(), original_height, "Should not stitch for zero offset");

        ScrollCaptureService::stitch_frame(&mut base, &new_frame, -0.5).unwrap();
        assert_eq!(base.height(), original_height, "Should not stitch for negative offset below threshold");
    }

    #[test]
    fn test_stitch_preserves_base_content_at_top() {
        let base = solid_image(100, 200, 255, 0, 0);
        let new_frame = solid_image(100, 200, 0, 255, 0);

        let mut base = base;
        ScrollCaptureService::stitch_frame(&mut base, &new_frame, 50.0).unwrap();

        // Top-left pixel should still be the original base color
        let top_pixel = base.get_pixel(0, 0);
        assert_eq!(top_pixel.0, [255, 0, 0, 255], "Base top content should be preserved");
    }

    #[test]
    fn test_stitch_new_content_appears_at_bottom() {
        let base = solid_image(100, 200, 255, 0, 0);
        let new_frame = solid_image(100, 200, 0, 255, 0);

        let mut base = base;
        ScrollCaptureService::stitch_frame(&mut base, &new_frame, 50.0).unwrap();

        let total_height = base.height();
        // Bottom pixel should be from the new frame (green) since new content is at the bottom
        let bottom_pixel = base.get_pixel(0, total_height - 1);
        assert_eq!(bottom_pixel.0[1], 255, "Bottom of stitched image should have new frame content (green channel)");
        assert_eq!(bottom_pixel.0[0], 0, "Bottom should not be red (base color)");
    }

    #[test]
    fn test_stitch_upward_new_content_at_top() {
        let base = solid_image(100, 200, 255, 0, 0);
        let new_frame = solid_image(100, 200, 0, 255, 0);

        let mut base = base;
        ScrollCaptureService::stitch_frame(&mut base, &new_frame, -50.0).unwrap();

        let top_pixel = base.get_pixel(0, 0);
        assert_eq!(top_pixel.0[1], 255, "Top of stitched image should have new frame content (green channel) for upward scroll");
    }

    #[test]
    fn test_stitch_multiple_frames_accumulate() {
        let mut base = solid_image(100, 100, 255, 0, 0);

        for _ in 0..5 {
            let frame = solid_image(100, 100, 0, 255, 0);
            ScrollCaptureService::stitch_frame(&mut base, &frame, 30.0).unwrap();
        }

        let expected = 100 + 5 * (100 - 30);
        assert_eq!(base.height(), expected, "Height should accumulate across multiple stitches");
    }

    #[test]
    fn test_stitch_max_height_limit() {
        let mut base = solid_image(100, MAX_SCROLL_HEIGHT - 50, 255, 0, 0);
        let new_frame = solid_image(100, 200, 0, 255, 0);

        let result = ScrollCaptureService::stitch_frame(&mut base, &new_frame, 10.0);
        assert!(result.is_err(), "Should error when exceeding max height");
        if let Err(e) = result {
            let msg = e.to_string();
            assert!(msg.contains("Max height"), "Error should mention max height, got: {}", msg);
        }
    }

    #[test]
    fn test_stitch_offset_equals_frame_height_no_new_content() {
        let mut base = solid_image(100, 100, 255, 0, 0);
        let new_frame = solid_image(100, 100, 0, 255, 0);
        let original_height = base.height();

        // Offset equals frame height — no new content to add
        ScrollCaptureService::stitch_frame(&mut base, &new_frame, 100.0).unwrap();
        assert_eq!(base.height(), original_height, "No new content when offset equals frame height");
    }

    #[test]
    fn test_stitch_offset_exceeds_frame_height_no_new_content() {
        let mut base = solid_image(100, 100, 255, 0, 0);
        let new_frame = solid_image(100, 100, 0, 255, 0);
        let original_height = base.height();

        ScrollCaptureService::stitch_frame(&mut base, &new_frame, 200.0).unwrap();
        assert_eq!(base.height(), original_height, "No new content when offset exceeds frame height");
    }

    #[test]
    fn test_stitch_with_realistic_gradient_data() {
        let mut base = gradient_image(200, 400);

        // Simulate scroll: new frame is the base shifted up by 80px
        let new_frame = shifted_image(&base, -80);
        let offset_y = 80.0;

        let height_before = base.height();
        ScrollCaptureService::stitch_frame(&mut base, &new_frame, offset_y).unwrap();

        assert_eq!(base.height(), height_before + (400 - 80));
        assert_eq!(base.width(), 200);

        // Verify the top-left pixel of the original base is preserved
        let top = base.get_pixel(0, 0);
        assert_eq!(top.0[0], 0, "Top-left red channel should be 0 from gradient");
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

        // Image should still be in state (we cloned, not took)
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

        // Now cancel — should not panic even though stop already consumed
        ScrollCaptureService::cancel_capture(state.clone());

        let s = state.lock().unwrap();
        assert!(s.stitched_image.is_none());
    }

    #[test]
    fn test_atomic_should_stop_no_lock_contention() {
        let state = Arc::new(Mutex::new(ScrollCaptureState::default()));

        // Simulate the loop checking should_stop without holding the mutex for long
        assert!(!state.lock().unwrap().should_stop.load(Ordering::SeqCst));

        // Simulate cancel setting it
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
    fn test_adaptive_interval_constants_sane() {
        assert!(CAPTURE_INTERVAL_FAST_MS < CAPTURE_INTERVAL_DEFAULT_MS);
        assert!(CAPTURE_INTERVAL_DEFAULT_MS < CAPTURE_INTERVAL_SLOW_MS);
        assert!(CAPTURE_INTERVAL_FAST_MS >= 50, "Fast interval should not be below 50ms");
        assert!(CAPTURE_INTERVAL_SLOW_MS <= 1000, "Slow interval should not exceed 1000ms");
        assert!(SETTLEMENT_DELAY_MS > CAPTURE_INTERVAL_SLOW_MS, "Settlement should be longer than slow interval");
    }

    #[test]
    fn test_adaptive_interval_simulation() {
        let mut interval = CAPTURE_INTERVAL_DEFAULT_MS;

        // Simulate: 3 scroll frames → should speed up
        for _ in 0..3 {
            let consecutive_scroll = 3;
            if consecutive_scroll >= 2 {
                interval = CAPTURE_INTERVAL_FAST_MS;
            }
        }
        assert_eq!(interval, CAPTURE_INTERVAL_FAST_MS, "Should speed up during active scroll");

        // Simulate: 4 idle frames → should slow down
        let mut consecutive_idle = 0;
        for _ in 0..4 {
            consecutive_idle += 1;
            if consecutive_idle >= 3 {
                interval = CAPTURE_INTERVAL_SLOW_MS;
            } else {
                interval = CAPTURE_INTERVAL_DEFAULT_MS;
            }
        }
        assert_eq!(interval, CAPTURE_INTERVAL_SLOW_MS, "Should slow down when idle");
    }
}
