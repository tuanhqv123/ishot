# BUSINESS SERVICES

**Generated:** 2025-01-05 18:33:19

## OVERVIEW
Core business logic with unique macOS integration patterns and hybrid language approach.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Screen capture | screen_capture.rs | Uses macOS screencapture CLI |
| OCR processing | ocr.rs | JIT Swift compilation for Vision framework |

## CONVENTIONS
- Services handle all system interactions
- Heavy use of `/tmp` for intermediate files
- Prefer CLI tools over Rust crates for stability
- Use `std::sync::Once` for one-time initialization

## ANTI-PATTERNS
- NEVER expose CLI details to commands layer
- DON'T hardcode temp paths - use consistent naming
- DON'T skip cleanup of temporary files