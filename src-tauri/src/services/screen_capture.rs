use crate::error::{AppError, Result};
use std::process::Command;
use std::time::Instant;
use core_graphics::display::CGDisplay;
use core_graphics::event::{CGEvent, CGEventTapLocation};
use core_graphics::geometry::CGPoint;

pub struct ScreenCaptureService;

impl ScreenCaptureService {
    /// Capture screen using screencapture command
    pub fn capture_main_display() -> Result<(Vec<u8>, u32, u32)> {
        let start = Instant::now();
        
        let temp_path = "/tmp/ishot_cap.png";
        
        // -x: no sound, -C: capture cursor, -t png: format
        let status = Command::new("screencapture")
            .args(["-x", "-C", "-t", "png", temp_path])
            .status()
            .map_err(|e| AppError::ScreenCapture(format!("screencapture failed: {}", e)))?;
        
        if !status.success() {
            return Err(AppError::ScreenCapture("screencapture failed".to_string()));
        }
        
        println!("[{:?}] screencapture done", start.elapsed());
        
        // Read file
        let png_data = std::fs::read(temp_path)
            .map_err(|e| AppError::ScreenCapture(format!("read failed: {}", e)))?;
        
        // Get dimensions from PNG header
        let decoder = png::Decoder::new(std::io::Cursor::new(&png_data));
        let reader = decoder.read_info()
            .map_err(|e| AppError::ScreenCapture(format!("PNG error: {}", e)))?;
        let width = reader.info().width;
        let height = reader.info().height;
        
        // Cleanup
        let _ = std::fs::remove_file(temp_path);
        
        println!("[{:?}] PNG {}x{}, {} bytes", start.elapsed(), width, height, png_data.len());
        
        Ok((png_data, width, height))
    }

    /// Get display bounds in logical pixels
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
}
