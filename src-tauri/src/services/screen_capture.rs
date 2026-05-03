use crate::error::{AppError, Result};
use std::process::Command;
use std::time::Instant;
use core_graphics::display::CGDisplay;
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

    /// Capture a region using screencapture CLI
    pub fn capture_region(x: f64, y: f64, width: f64, height: f64) -> Result<(Vec<u8>, u32, u32)> {
        let temp_path = format!("/tmp/ishot_scroll_{}.png", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis());
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

        let (w, h) = {
            let decoder = png::Decoder::new(std::io::Cursor::new(&png_data));
            let reader = decoder.read_info()
                .map_err(|e| AppError::ScreenCapture(format!("PNG decode failed: {}", e)))?;
            (reader.info().width, reader.info().height)
        };

        Ok((png_data, w, h))
    }
}
