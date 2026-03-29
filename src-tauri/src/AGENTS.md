# RUST BACKEND

**Generated:** 2025-01-05 18:33:19

## OVERVIEW
Core Rust backend with dual-window system, macOS integration, and service layer.

## STRUCTURE
```
src-tauri/src/
├── main.rs              # Entry point, tray, shortcuts, window lifecycle
├── error.rs             # Centralized error handling with serde
├── commands/            # IPC command handlers
└── services/            # Business logic layer
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| App lifecycle | main.rs | Tray setup, global shortcuts, window management |
| Error handling | error.rs | AppError enum with thiserror + serde |
| IPC bridge | commands/ | Tauri command wrappers |
| Business logic | services/ | OCR, screen capture, core operations |

## CONVENTIONS
- Use `thiserror` for error types with `serde::Serialize`
- Services abstract complex system calls
- Commands are thin wrappers around services
- `unsafe` blocks for macOS-specific window operations

## ANTI-PATTERNS
- NEVER call frontend from backend (use events)
- DON'T skip error propagation through `AppError`
- DON'T use blocking operations in commands