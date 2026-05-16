use crate::error::{AppError, Result};
use std::process::Command;
use std::time::Instant;
use core_graphics::display::CGDisplay;
use core_graphics::geometry::{CGPoint, CGRect, CGSize};
use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct MonitorInfo {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale_factor: f64,
}

pub struct ScreenCaptureService;

impl ScreenCaptureService {
    /// Capture all displays into one composite PNG, stitched by logical position.
    /// Returns (png_bytes, physical_width, physical_height).
    pub fn capture_all_displays() -> Result<(Vec<u8>, u32, u32)> {
        let start = Instant::now();
        let monitors = Self::get_monitors_info()?;

        if monitors.is_empty() {
            return Err(AppError::ScreenCapture("No displays found".to_string()));
        }

        // Single display: fast path
        if monitors.len() == 1 {
            return Self::capture_display(1);
        }

        let (vx, vy, vw, vh) = Self::get_virtual_screen_bounds()?;
        let max_scale = monitors.iter().map(|m| m.scale_factor).fold(1.0_f64, f64::max);
        let comp_w = (vw * max_scale).round() as u32;
        let comp_h = (vh * max_scale).round() as u32;
        println!("[capture] composite {}x{} (virtual {}x{} @ {}x)", comp_w, comp_h, vw, vh, max_scale);

        let mut composite = image::RgbaImage::new(comp_w, comp_h);

        for (i, monitor) in monitors.iter().enumerate() {
            let display_num = i + 1; // screencapture -D is 1-indexed
            match Self::capture_display(display_num) {
                Ok((png_data, _, _)) => {
                    match image::load_from_memory(&png_data) {
                        Ok(img) => {
                            let dest_x = ((monitor.x - vx) * max_scale).round() as i64;
                            let dest_y = ((monitor.y - vy) * max_scale).round() as i64;
                            println!("[{:?}] display {} at ({},{}) in composite", start.elapsed(), display_num, dest_x, dest_y);
                            image::imageops::overlay(&mut composite, &img.to_rgba8(), dest_x, dest_y);
                        }
                        Err(e) => eprintln!("[capture] decode display {} failed: {}", display_num, e),
                    }
                }
                Err(e) => eprintln!("[capture] display {} failed: {}", display_num, e),
            }
        }

        println!("[{:?}] composite assembled", start.elapsed());

        // Use JPEG for composite — ~10x faster than PNG for large images
        let rgb_image = image::DynamicImage::ImageRgba8(composite).to_rgb8();
        let mut jpg_bytes: Vec<u8> = Vec::new();
        rgb_image
            .write_to(
                &mut std::io::Cursor::new(&mut jpg_bytes),
                image::ImageFormat::Jpeg,
            )
            .map_err(|e| AppError::ScreenCapture(format!("encode composite: {}", e)))?;

        println!("[{:?}] JPEG {}x{}, {} bytes", start.elapsed(), comp_w, comp_h, jpg_bytes.len());
        Ok((jpg_bytes, comp_w, comp_h))
    }

    /// Capture a single display by 1-based index (matches screencapture -D n).
    pub fn capture_display(display_num: usize) -> Result<(Vec<u8>, u32, u32)> {
        let start = Instant::now();
        let temp_path = format!("/tmp/ishot_d{}.png", display_num);

        let status = Command::new("screencapture")
            .args(["-x", "-C", "-t", "png", "-D", &display_num.to_string(), &temp_path])
            .status()
            .map_err(|e| AppError::ScreenCapture(format!("screencapture -D{} failed: {}", display_num, e)))?;

        if !status.success() {
            return Err(AppError::ScreenCapture(format!("screencapture -D{} failed", display_num)));
        }

        println!("[{:?}] screencapture -D{} done", start.elapsed(), display_num);

        let png_data = std::fs::read(&temp_path)
            .map_err(|e| AppError::ScreenCapture(format!("read display {} failed: {}", display_num, e)))?;
        let _ = std::fs::remove_file(&temp_path);

        let decoder = png::Decoder::new(std::io::Cursor::new(&png_data));
        let reader = decoder
            .read_info()
            .map_err(|e| AppError::ScreenCapture(format!("PNG error: {}", e)))?;
        let width = reader.info().width;
        let height = reader.info().height;

        println!("[{:?}] display {} PNG {}x{}", start.elapsed(), display_num, width, height);
        Ok((png_data, width, height))
    }

    /// Get virtual screen bounds (union of all monitors) in logical pixels.
    pub fn get_virtual_screen_bounds() -> Result<(f64, f64, f64, f64)> {
        let monitors = Self::get_monitors_info()?;
        if monitors.is_empty() {
            return Self::get_display_bounds();
        }

        let mut min_x = f64::MAX;
        let mut min_y = f64::MAX;
        let mut max_x = f64::MIN;
        let mut max_y = f64::MIN;

        for m in &monitors {
            min_x = min_x.min(m.x);
            min_y = min_y.min(m.y);
            max_x = max_x.max(m.x + m.width);
            max_y = max_y.max(m.y + m.height);
        }

        Ok((min_x, min_y, max_x - min_x, max_y - min_y))
    }

    /// Get info for all active monitors.
    pub fn get_monitors_info() -> Result<Vec<MonitorInfo>> {
        let display_ids = CGDisplay::active_displays()
            .map_err(|e| AppError::ScreenCapture(format!("active_displays failed: {}", e)))?;

        let mut monitors = Vec::new();
        for id in display_ids {
            let display = CGDisplay::new(id);
            let bounds = display.bounds();
            // pixel_width() from display_mode() gives actual HiDPI/Retina physical pixels
            let scale = display
                .display_mode()
                .map(|mode| {
                    let phys_w = mode.pixel_width() as f64;
                    let log_w = bounds.size.width;
                    if log_w > 0.0 { phys_w / log_w } else { 1.0 }
                })
                .unwrap_or(1.0);
            monitors.push(MonitorInfo {
                x: bounds.origin.x,
                y: bounds.origin.y,
                width: bounds.size.width,
                height: bounds.size.height,
                scale_factor: scale,
            });
        }
        Ok(monitors)
    }

    /// Get display bounds in logical pixels (main display only).
    pub fn get_display_bounds() -> Result<(f64, f64, f64, f64)> {
        let display = CGDisplay::main();
        let bounds = display.bounds();
        Ok((
            bounds.origin.x,
            bounds.origin.y,
            bounds.size.width,
            bounds.size.height,
        ))
    }

    /// Capture a region using screencapture CLI.
    ///
    /// NOTE: deliberately **does NOT** pass `-C` (capture cursor). Including the
    /// cursor pointer in scroll-capture frames causes two problems:
    ///   1. The cursor sits at a different position every frame → the NCC offset
    ///      detector sees a moving white-arrow shape that isn't really content,
    ///      reducing confidence and biasing the match.
    ///   2. The cursor gets baked into the final stitched image as multiple
    ///      ghost copies along the scroll path.
    /// For one-shot screenshots (`capture_display`) we DO want the cursor, but
    /// this function is only used by scroll capture.
    pub fn capture_region(x: f64, y: f64, width: f64, height: f64) -> Result<(Vec<u8>, u32, u32)> {
        let temp_path = format!("/tmp/ishot_scroll_{}.png", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis());
        let region = format!("{},{},{},{}", x as i32, y as i32, width as i32, height as i32);

        let status = Command::new("screencapture")
            .args(["-x", "-R", &region, &temp_path])
            .status()
            .map_err(|e| AppError::ScreenCapture(format!("screencapture failed: {}", e)))?;

        if !status.success() {
            return Err(AppError::ScreenCapture("screencapture failed".to_string()));
        }

        let png_data = std::fs::read(&temp_path)
            .map_err(|e| AppError::ScreenCapture(format!("read capture failed: {}", e)))?;
        let _ = std::fs::remove_file(&temp_path);

        let (w, h) = {
            let decoder = png::Decoder::new(std::io::Cursor::new(&png_data));
            let reader = decoder.read_info()
                .map_err(|e| AppError::ScreenCapture(format!("PNG decode failed: {}", e)))?;
            (reader.info().width, reader.info().height)
        };

        Ok((png_data, w, h))
    }

    /// Convert a raw BGRA byte buffer (Apple's native pixel order, possibly with
    /// row padding) into a tight RGBA8 buffer. Pure function, easily testable.
    ///
    /// `src` is the source buffer, `stride` is the byte distance between row
    /// starts in `src` (may be ≥ `width × 4` if the platform padded rows).
    pub(crate) fn bgra_to_rgba(src: &[u8], width: usize, height: usize, stride: usize) -> Vec<u8> {
        let row_bytes = width * 4;
        let mut dst = vec![0u8; row_bytes * height];
        for row in 0..height {
            let s_off = row * stride;
            let d_off = row * row_bytes;
            for col in 0..width {
                let so = s_off + col * 4;
                let dop = d_off + col * 4;
                // Apple's display CGImage is in BGRA byte order; swap to RGBA
                // for the rest of the pipeline (`image::RgbaImage`, NCC, etc.).
                dst[dop]     = src[so + 2]; // R ← B
                dst[dop + 1] = src[so + 1]; // G ← G
                dst[dop + 2] = src[so];     // B ← R
                dst[dop + 3] = src[so + 3]; // A
            }
        }
        dst
    }

    /// Capture a screen region via the native CGDisplay API.
    ///
    /// Returns an RGBA `image::RgbaImage` directly — no PNG round-trip — which
    /// is what every caller actually wants. The screencapture-subprocess path
    /// in `capture_region` is now a fallback (selectable via `ISHOT_CAPTURE`).
    ///
    /// Cost on M-series Mac for a typical 1500×700 rect: ~6 ms grab + ~3 ms
    /// channel-swap = ~9 ms. Compare to ~70 ms for the screencapture path
    /// (subprocess fork + write/read PNG + decode + to_rgba8).
    ///
    /// `x, y, width, height` are in LOGICAL screen coordinates (global, same
    /// space the frontend uses). On Retina (2× scale), the returned image is
    /// in PHYSICAL pixels (= 2× the logical width/height).
    ///
    /// LIMITATION: if the rect spans two displays, this errors. screencapture
    /// handles the seam transparently; native API can only grab from one
    /// display. Acceptable trade for the 5-10× speedup on the normal case.
    pub fn capture_region_native(x: f64, y: f64, width: f64, height: f64) -> Result<image::RgbaImage> {
        // 1. Find the display containing the rect's top-left and translate
        //    global coords to that display's local space.
        let active = CGDisplay::active_displays()
            .map_err(|e| AppError::ScreenCapture(format!("CGDisplay::active_displays failed: {:?}", e)))?;

        let mut chosen: Option<(CGDisplay, CGRect)> = None;
        for id in &active {
            let d = CGDisplay::new(*id);
            let b = d.bounds();
            if x >= b.origin.x
                && y >= b.origin.y
                && x < b.origin.x + b.size.width
                && y < b.origin.y + b.size.height
            {
                chosen = Some((d, b));
                break;
            }
        }
        let (display, bounds) = chosen.ok_or_else(|| {
            AppError::ScreenCapture(format!(
                "no display contains ({}, {}) — rect spans displays or off-screen?",
                x as i32, y as i32
            ))
        })?;

        let local_x = x - bounds.origin.x;
        let local_y = y - bounds.origin.y;
        let rect = CGRect::new(
            &CGPoint::new(local_x, local_y),
            &CGSize::new(width, height),
        );

        // 2. Grab the image. Synchronous; ~few ms on M-series.
        let cg_image = display
            .image_for_rect(rect)
            .ok_or_else(|| AppError::ScreenCapture("CGDisplay::image_for_rect returned null".into()))?;

        // 3. Extract bytes. Width/height are in PHYSICAL pixels.
        let w_px = cg_image.width() as u32;
        let h_px = cg_image.height() as u32;
        let stride = cg_image.bytes_per_row();
        let cf = cg_image.data();
        let bgra = cf.bytes();

        let rgba = Self::bgra_to_rgba(bgra, w_px as usize, h_px as usize, stride);
        image::RgbaImage::from_raw(w_px, h_px, rgba)
            .ok_or_else(|| AppError::ScreenCapture("RgbaImage::from_raw failed".into()))
    }

    /// Dispatch capture to either the native CGImage path or the legacy
    /// `screencapture` subprocess path, based on the `ISHOT_CAPTURE` env var.
    ///
    /// - `native` (default for auto-scroll): fast path via `CGDisplay::image_for_rect`
    /// - `screencapture`: legacy subprocess path, kept as a safety fallback
    /// - any other value: native
    ///
    /// Returns RGBA directly — callers that previously decoded the PNG can
    /// skip that step.
    pub fn capture_region_rgba(x: f64, y: f64, width: f64, height: f64) -> Result<image::RgbaImage> {
        let backend = std::env::var("ISHOT_CAPTURE").unwrap_or_else(|_| "native".to_string());
        if backend == "screencapture" {
            let (png, _, _) = Self::capture_region(x, y, width, height)?;
            let img = image::load_from_memory(&png)
                .map_err(|e| AppError::ScreenCapture(format!("decode legacy PNG: {}", e)))?
                .to_rgba8();
            return Ok(img);
        }
        Self::capture_region_native(x, y, width, height)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bgra_to_rgba_swaps_channels_no_padding() {
        // 2×1 image: pixel 0 = BGRA(10, 20, 30, 255), pixel 1 = BGRA(40, 50, 60, 200)
        let src = vec![
            10, 20, 30, 255,
            40, 50, 60, 200,
        ];
        let dst = ScreenCaptureService::bgra_to_rgba(&src, 2, 1, 8);
        // pixel 0 RGBA(30, 20, 10, 255) — R and B swapped, A preserved
        assert_eq!(&dst[0..4], &[30, 20, 10, 255]);
        // pixel 1 RGBA(60, 50, 40, 200)
        assert_eq!(&dst[4..8], &[60, 50, 40, 200]);
    }

    #[test]
    fn bgra_to_rgba_handles_row_padding() {
        // 2×2 image with stride = 12 (4-byte row padding at the end).
        // Output buffer must be tight (8 bytes per row), padding stripped.
        let src = vec![
            // row 0: 2 pixels + 4 padding bytes
            1, 2, 3, 255,    4, 5, 6, 255,    0xAA, 0xBB, 0xCC, 0xDD,
            // row 1: 2 pixels + 4 padding bytes
            7, 8, 9, 100,    10, 11, 12, 100, 0x11, 0x22, 0x33, 0x44,
        ];
        let dst = ScreenCaptureService::bgra_to_rgba(&src, 2, 2, 12);
        assert_eq!(dst.len(), 2 * 2 * 4, "output should be tight RGBA");
        // row 0
        assert_eq!(&dst[0..4], &[3, 2, 1, 255]);
        assert_eq!(&dst[4..8], &[6, 5, 4, 255]);
        // row 1
        assert_eq!(&dst[8..12], &[9, 8, 7, 100]);
        assert_eq!(&dst[12..16], &[12, 11, 10, 100]);
    }

    #[test]
    fn bgra_to_rgba_zero_size_safe() {
        let src: Vec<u8> = vec![];
        let dst = ScreenCaptureService::bgra_to_rgba(&src, 0, 0, 0);
        assert_eq!(dst.len(), 0);
    }

    #[test]
    fn bgra_to_rgba_preserves_alpha_independently() {
        // Verify alpha is taken from src position 3, not blended with anything.
        let src = vec![0, 0, 0, 42,    255, 255, 255, 7];
        let dst = ScreenCaptureService::bgra_to_rgba(&src, 2, 1, 8);
        assert_eq!(dst[3], 42);
        assert_eq!(dst[7], 7);
    }
}
