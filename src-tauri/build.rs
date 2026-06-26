fn main() {
    // Weak-link ScreenCaptureKit (macOS 12.3+) so we can capture the rendered
    // desktop wallpaper (incl. dynamic/aerial) via SCScreenshotManager. Weak so
    // the binary still launches on older macOS where the framework is absent.
    println!("cargo:rustc-link-arg=-Wl,-weak_framework,ScreenCaptureKit");
    tauri_build::build()
}
