/// Test file to verify xcap works correctly
/// Run with: cargo test --test xcap_test

use xcap::Monitor;
use std::path::PathBuf;

#[test]
fn test_get_all_monitors() {
    println!("=== Test: Get All Monitors ===");
    match Monitor::all() {
        Ok(monitors) => {
            println!("Found {} monitors", monitors.len());
            assert!(!monitors.is_empty(), "Should have at least one monitor");

            for (i, monitor) in monitors.iter().enumerate() {
                println!(
                    "Monitor {}: name={:?}, x={}, y={}, width={}, height={}, scale_factor={}, primary={}",
                    i,
                    monitor.name(),
                    monitor.x().unwrap_or(0),
                    monitor.y().unwrap_or(0),
                    monitor.width().unwrap_or(0),
                    monitor.height().unwrap_or(0),
                    monitor.scale_factor().unwrap_or(1.0),
                    monitor.is_primary().unwrap_or(false)
                );
            }
        }
        Err(e) => {
            eprintln!("Error getting monitors: {:?}", e);
            panic!("Failed to get monitors");
        }
    }
}

#[test]
fn test_capture_main_screen() {
    println!("\n=== Test: Capture Main Screen ===");

    let monitors = Monitor::all().expect("Failed to get monitors");
    let primary = monitors.iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())
        .expect("No monitor found");

    println!("Capturing screen...");
    match primary.capture_image() {
        Ok(image) => {
            println!("Success! Captured: {}x{}", image.width(), image.height());

            // Create debug output directory
            let debug_dir = PathBuf::from("/tmp/ishot_debug");
            std::fs::create_dir_all(&debug_dir).unwrap();

            // Save full screenshot
            let full_path = debug_dir.join("full_capture.png");
            image.save(&full_path).unwrap();
            println!("Saved to: {:?}", full_path);

            // Verify file exists
            assert!(full_path.exists(), "Screenshot file should exist");
            let metadata = std::fs::metadata(&full_path).unwrap();
            println!("File size: {} bytes", metadata.len());
            assert!(metadata.len() > 0, "Screenshot should not be empty");
        }
        Err(e) => {
            eprintln!("Failed to capture: {:?}", e);
            panic!("Screen capture failed");
        }
    }
}

#[test]
fn test_capture_region() {
    println!("\n=== Test: Capture Region ===");

    let monitors = Monitor::all().expect("Failed to get monitors");
    let primary = monitors.iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())
        .expect("No monitor found");

    // Capture 400x300 region from position (100, 100)
    let region_x = 100u32;
    let region_y = 100u32;
    let region_width = 400u32;
    let region_height = 300u32;

    println!("Capturing region: x={}, y={}, width={}, height={}", region_x, region_y, region_width, region_height);

    match primary.capture_region(region_x, region_y, region_width, region_height) {
        Ok(image) => {
            println!("Success! Captured region: {}x{}", image.width(), image.height());

            let debug_dir = PathBuf::from("/tmp/ishot_debug");
            std::fs::create_dir_all(&debug_dir).unwrap();

            let region_path = debug_dir.join("region_capture.png");
            image.save(&region_path).unwrap();
            println!("Saved to: {:?}", region_path);

            assert!(region_path.exists(), "Region screenshot file should exist");
            assert_eq!(image.width(), region_width, "Width should match");
            assert_eq!(image.height(), region_height, "Height should match");
        }
        Err(e) => {
            eprintln!("Failed to capture region: {:?}", e);
            panic!("Region capture failed");
        }
    }
}

#[test]
fn test_png_bytes() {
    println!("\n=== Test: Convert to PNG Bytes ===");

    let monitors = Monitor::all().expect("Failed to get monitors");
    let primary = monitors.iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())
        .expect("No monitor found");

    match primary.capture_image() {
        Ok(image) => {
            use std::io::Cursor;

            // Create debug output directory
            let debug_dir = PathBuf::from("/tmp/ishot_debug");
            std::fs::create_dir_all(&debug_dir).unwrap();

            // Convert to PNG bytes
            let mut buffer = Cursor::new(Vec::new());
            match image.write_to(&mut buffer, image::ImageFormat::Png) {
                Ok(_) => {
                    let png_bytes = buffer.into_inner();
                    println!("PNG bytes: {} bytes", png_bytes.len());
                    assert!(png_bytes.len() > 0, "PNG should not be empty");

                    // Save bytes to verify
                    let bytes_path = debug_dir.join("from_bytes.png");
                    std::fs::write(&bytes_path, &png_bytes).unwrap();
                    println!("Saved bytes to: {:?}", bytes_path);

                    // Also save the original for comparison
                    let original_path = debug_dir.join("from_bytes_original.png");
                    image.save(&original_path).unwrap();

                    println!("✓ Both files should be identical");
                }
                Err(e) => {
                    eprintln!("Failed to encode PNG: {:?}", e);
                    panic!("PNG encoding failed");
                }
            }
        }
        Err(e) => {
            eprintln!("Failed to capture: {:?}", e);
            panic!("Screen capture failed");
        }
    }
}

