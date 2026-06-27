fn main() {
    // Weak-link ScreenCaptureKit (macOS 12.3+) so we can capture the rendered
    // desktop wallpaper (incl. dynamic/aerial) via SCScreenshotManager. Weak so
    // the binary still launches on older macOS where the framework is absent.
    println!("cargo:rustc-link-arg=-Wl,-weak_framework,ScreenCaptureKit");
    // ServiceManagement (macOS 13+) — register the app itself as a login item
    // via SMAppService so "launch at login" shows the APP name, not the
    // Developer-ID team. Weak so older macOS still links.
    println!("cargo:rustc-link-arg=-Wl,-weak_framework,ServiceManagement");
    tauri_build::build()
}
