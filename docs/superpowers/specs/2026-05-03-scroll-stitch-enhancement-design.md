# Scroll Capture Stitch Enhancement — Design

**Date**: 2026-05-03
**Scope**: `src-tauri/src/services/scroll_capture.rs`

## Problem

Current stitch algorithm has 5 issues causing misaligned, blurry scroll captures:

1. **Integer-only offset** — `detect_offset_pixels()` returns `u32`, no sub-pixel precision
2. **Conflicting algorithms** — `detect_offset_pixels()` and `find_offset_and_cut()` are independent, can disagree
3. **Cut point blend is wrong** — one-directional alpha fade creates visible seam lines
4. **Pixel-by-pixel copy** — `get_pixel/put_pixel` loop is slow for large images
5. **Broken tests** — reference `CAPTURE_INTERVAL_SLOW_MS` which doesn't exist

## Solution

### 1. Replace offset detection with NCC

**Remove**: `detect_offset_pixels()`, `find_offset_and_cut()`
**Add**: `detect_offset_ncc(prev, curr) -> OffsetResult { offset: u32, confidence: f64 }`

**Algorithm**:
- Coarse scan (step 2): NCC over 30 overlap rows, sample every 3 columns
- Refine (±5, step 1): full-resolution NCC around best candidate
- Confirm: verify with middle-region comparison (rows 15-45)
- Return offset + confidence (0.0-1.0)
- Accept offset if confidence >= 0.7, else treat as "no scroll"

**Why NCC over SAD**:
- Insensitive to brightness fluctuations (hover effects, screen dim)
- Score normalized 0→1, easy threshold
- Industry standard for template matching

### 2. Overlap weighted blend

**Remove**: cut-point search + one-directional alpha fade
**Add**: Full overlap zone weighted blend

For each row `y` in overlap zone (0..offset):
- `weight = y as f32 / offset as f32`  (0 at top of overlap → 1 at bottom)
- `pixel = base_pixel * (1 - weight) + new_pixel * weight`

This creates a smooth gradient transition across the entire overlap, no sharp seams.

### 3. Buffer copy for performance

**Remove**: per-pixel `get_pixel/put_pixel` for non-overlap regions
**Add**: `copy_from_slice` via row iterators for bulk copy
- Only blend pixel-by-pixel in overlap zone (small portion of image)
- Non-overlap regions: copy entire rows at once

### 4. Fix tests

- Remove references to `CAPTURE_INTERVAL_SLOW_MS`
- Update tests to use new `OffsetResult` return type
- Add NCC-specific tests (known offsets, edge cases)

## Data Flow (Updated)

```
capture_loop:
  frame1 = capture()
  
  idle_phase:
    frame2 = capture()
    if frames_differ(prev, frame2):
      result = detect_offset_ncc(prev, frame2)
      if result.confidence >= 0.7 && result.offset >= min_offset:
        stitch_frame(stitched, frame2, result)  // pass OffsetResult
        → active_phase
  
  active_phase:
    frame3 = capture()
    result = detect_offset_ncc(prev, frame3)
    if result.confidence >= 0.7 && result.offset >= min_offset:
      stitch_frame(stitched, frame3, result)
    else:
      no_change_count++
      if no_change_count >= 2:
        → idle_phase
```

## API Changes

None. All changes are internal to `scroll_capture.rs`. IPC layer (`commands/screenshot.rs`) and frontend (`App.tsx`) untouched.

## File Changes

Only `src-tauri/src/services/scroll_capture.rs`:
- Remove: `detect_offset_pixels()`, `find_offset_and_cut()`
- Add: `detect_offset_ncc()`, `OffsetResult` struct
- Rewrite: `stitch_frame()` with overlap blend + buffer copy
- Fix: tests

## Success Criteria

- Offset detection accuracy: >= 95% correct offset (compared to manual measurement)
- No visible seam lines in stitched output
- Performance: stitch frame in < 50ms for 4K image
- All tests pass
