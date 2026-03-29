# IPC COMMANDS

**Generated:** 2025-01-05 18:33:19

## OVERVIEW
Tauri command handlers providing IPC bridge between frontend and backend services.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Screen capture | screenshot.rs | Main capture command |
| Window management | window.rs | Show/hide overlay window |
| Clipboard/Files | file.rs | Copy to clipboard, save to disk |

## CONVENTIONS
- Commands are thin wrappers around service methods
- Always return `Result<T, String>` for frontend compatibility
- Use `#[tauri::command]` macro
- Handle service errors and convert to strings

## ANTI-PATTERNS
- NEVER put business logic in commands
- DON'T use async/await unless service requires it
- DON'T access frontend state directly