# PROJECT KNOWLEDGE BASE

**Generated:** 2025-01-05 18:33:19
**Commit:** [Current working directory]
**Branch:** [Current working directory]

## OVERVIEW
iShot is a macOS screenshot and annotation tool built with Tauri 2.0 (Rust backend + React/TypeScript frontend). Runs as menu bar app with global hotkey screen capture.

## STRUCTURE
```
./
├── src/                    # Frontend (React/TypeScript)
├── src-tauri/              # Rust backend
│   ├── src/
│   │   ├── commands/      # IPC layer
│   │   └── services/      # Business logic
│   └── capabilities/       # Tauri 2.0 permissions
├── build.sh                # Custom build script
├── run.sh                  # Dev runner
└── CLAUDE.md               # Project guidance
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Screen capture | src-tauri/src/services/screen_capture.rs | Uses macOS screencapture CLI |
| OCR implementation | src-tauri/src/services/ocr.rs | JIT Swift compilation |
| Frontend state machine | src/App.tsx | 617 lines, handles all UI logic |
| Window management | src-tauri/src/main.rs | Dual window system |
| IPC commands | src-tauri/src/commands/ | Tauri command handlers |
| Error handling | src-tauri/src/error.rs | Centralized error types |

## CODE MAP
| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| main | fn | src-tauri/src/main.rs | - | App entry point |
| App | fc | src/App.tsx | - | Main overlay component |
| OcrService | st | src-tauri/src/services/ocr.rs | - | OCR via Swift JIT |
| ScreenCaptureService | st | src-tauri/src/services/screen_capture.rs | - | Screen capture logic |
| capture_screen | cmd | src-tauri/src/commands/screenshot.rs | - | IPC capture command |

## CONVENTIONS
- **Package Manager**: Use Bun (not npm)
- **Build**: Custom build.sh with ad-hoc signing
- **Testing**: Manual verification, saves to /tmp/ishot_debug/
- **Temp Files**: Heavy use of /tmp for IPC

## ANTI-PATTERNS (THIS PROJECT)
- **NEVER** use npm - always Bun
- **NEVER** skip macOS-private-api feature
- **DO NOT** assume screen recording permission
- **ALWAYS** use raw RGBA for clipboard (not PNG)

## UNIQUE STYLES
- OCR via dynamic Swift compilation
- Dual window "keeper" system for menu bar lifecycle
- CLI-based screen capture for stability
- Box blur in main thread (App.tsx)

## COMMANDS
```bash
# Development
bun run tauri dev

# Build
./build.sh

# Rust tests
cd src-tauri && cargo test

# Check compilation
cd src-tauri && cargo check
```

## NOTES
- Screen recording permission required on first launch
- App uses 1x1px "keeper" window to stay alive
- Overlay window level set to 1000+ to stay above all UI
- Migration from screenshots crate to screencapture CLI complete