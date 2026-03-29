# FRONTEND OVERLAY

**Generated:** 2025-01-05 18:33:19

## OVERVIEW
React/TypeScript overlay with complex state machine and canvas-based annotation engine.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| State machine | App.tsx (lines 26-64) | idle → selecting → editing transitions |
| Image processing | App.tsx (lines 68-106) | Box blur algorithm in main thread |
| Hit detection | App.tsx (lines 287-319) | Geometry math for annotations |
| OCR integration | App.tsx (lines 163-184) | Coordinate transforms for text blocks |

## CONVENTIONS
- Single component manages all overlay logic
- Canvas-based rendering for annotations
- Base64 for image display, byte arrays for processing
- Manual coordinate transforms for Retina displays

## ANTI-PATTERNS
- NEVER block UI thread (but box blur does - consider Web Worker)
- DON'T mix display and processing data formats
- DON'T skip coordinate transform calculations