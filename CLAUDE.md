# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

iShot is a macOS screenshot and annotation tool built with **Tauri 2.0** (Rust backend + React/TypeScript frontend). The app runs as a menu bar application with a global hotkey to trigger screen capture.

## Key Architecture

### Dual Window System

The app uses two windows to handle the menu bar lifecycle:

1. **"keeper" window**: A 1x1px invisible window at position (-100, -100) that keeps the Tauri app alive. Without this, Tauri would exit when no visible windows are present (menu bar apps have no main window).
2. **"overlay" window**: A transparent fullscreen window that appears when the user triggers a screenshot. It handles:
   - Displaying the captured screenshot
   - Region selection via mouse drag
   - Annotation toolbar

### Event Flow

```
User presses Cmd+Shift+A
    ↓
Global shortcut handler (main.rs) fires
    ↓
Show overlay window + emit "screenshot-triggered" event
    ↓
Frontend (App.tsx) receives event
    ↓
Invoke "capture_screen" command (Rust)
    ↓
Display screenshot with dark overlay
    ↓
User drags to select region
    ↓
Show annotation toolbar below selection
    ↓
User clicks Done → crop region + copy to clipboard
```

### Global Shortcut Handler

**IMPORTANT**: The handler intentionally does NOT call `overlay.set_focus()`. This allows the user to trigger screenshots from any app without the iShot window stealing focus. The overlay appears on top but doesn't become the active application.

### Tauri 2.0 Capabilities

The app uses Tauri 2.0's capabilities system for permissions. All frontend-backend communication permissions are defined in:
- `src-tauri/capabilities/default.json`

When adding new Tauri commands or window operations, update this file to include the required permissions (e.g., `core:event:allow-emit`, `core:window:allow-show`).

## Development Commands

**Run development server:**
```bash
bun run tauri dev
```

**Build for production:**
```bash
bun run tauri build
```

**Run Rust tests:**
```bash
cd src-tauri && cargo test
```

**Run a specific test:**
```bash
cd src-tauri && cargo test --test test_name
```

**Check Rust compilation (without building):**
```bash
cd src-tauri && cargo check
```

**Note**: The package manager is **Bun**, not npm. Use `bun run` for all package.json scripts.

## Code Structure

### Backend (Rust) - `src-tauri/src/`

- **main.rs**: App entry point, tray icon setup, global shortcut registration, display bounds detection
- **error.rs**: Central error types with `thiserror` and serde serialization
- **commands/**: Tauri command handlers (IPC layer)
  - `screenshot.rs`: Screen capture commands
  - `window.rs`: Window show/hide commands
  - `file.rs`: Clipboard and file save commands
- **services/**: Business logic layer
  - `screen_capture.rs`: Screen capture implementation using the `screenshots` crate

### Frontend (TypeScript) - `src/`

- **App.tsx**: Main overlay component with region selection, state machine (idle → selecting → annotating)
- **styles.css**: Overlay styling, dark dim effect, toolbar frosted glass effect

## Key Dependencies

### Rust (Cargo.toml)
- `tauri 2.0` - Application framework with `macos-private-api` feature
- `tauri-plugin-global-shortcut` - Global hotkey registration
- `tray-icon` - Menu bar icon
- `screenshots` or `xcap` - Screen capture (currently migrating from screenshots to xcap)
- `arboard` - Cross-platform clipboard with `image-data` feature
- `image` - Image encoding/decoding

### Frontend (package.json)
- `@tauri-apps/api` - Tauri frontend APIs
- `@tauri-apps/plugin-global-shortcut` - Global shortcut plugin
- `react` + `react-dom` - UI framework
- `vite` - Build tool and dev server

## Screen Recording Permission

macOS requires screen recording permission for screen capture. The app requests this on first launch by attempting a capture in `main.rs` setup. If permission is denied, the system will prompt the user.

**Note**: The permission prompt only appears once. If denied, the user must manually grant permission in System Settings → Privacy & Security → Screen Recording.

## Current Implementation Notes

### Screen Capture

The app currently uses the `screenshots` crate, but there are known issues:
- `Screen::capture_area()` has bugs with returned dimensions
- The workaround is to capture full screen and crop with `image::DynamicImage::crop_imm()`

A migration to `xcap` is in progress. The xcap library has better documentation and a more reliable API.

### Clipboard

Clipboard operations use the `arboard` crate. The `ImageData` struct requires:
- `width: usize`
- `height: usize`
- `bytes: Cow<[u8]>` (raw RGBA pixel data, NOT PNG bytes)

PNG must be decoded first using `image::load_from_memory()`, then converted to RGBA8.

### Region Selection

The frontend uses a CSS-based dimming effect:
- Selected region: Clear, no dim
- Everything else: `box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.3)`

This creates the "everything outside is dimmed" effect without complex masking.

## File Paths

- Tray icon: `src-tauri/icons/tray_icon.png` (must be 32x32 RGBA PNG)
- Tauri config: `src-tauri/tauri.conf.json`
- Capabilities: `src-tauri/capabilities/default.json`
- Test files: `src-tauri/tests/`
