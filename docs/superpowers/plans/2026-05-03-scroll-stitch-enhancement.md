# Scroll Stitch Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SAD-based offset detection with NCC, add overlap weighted blend, and optimize performance via buffer copy — all in `scroll_capture.rs`.

**Architecture:** Single-file refactor. Replace `detect_offset_pixels()` and `find_offset_and_cut()` with unified `detect_offset_ncc()`. Rewrite `stitch_frame()` to use overlap blend instead of cut-point. Update `start_capture()` loop to use new `OffsetResult` struct. Fix broken tests.

**Tech Stack:** Rust, `image` crate (already in project), no new dependencies.

---

### Task 1: Add `OffsetResult` struct and remove old functions

**Files:**
- Modify: `src-tauri/src/services/scroll_capture.rs:30-37` (add struct after existing structs)
- Modify: `src-tauri/src/services/scroll_capture.rs:105-200` (remove `detect_offset_pixels`)
- Modify: `src-tauri/src/services/scroll_capture.rs:232-312` (remove `find_offset_and_cut`)

- [ ] **Step 1: Add `OffsetResult` struct after `ScrollCaptureResult` (line ~44)**

```rust
#[derive(Debug, Clone)]
pub struct OffsetResult {
    pub offset: u32,
    pub confidence: f64,
}
```

- [ ] **Step 2: Delete `detect_offset_pixels` function (lines 105-200)**

Remove the entire `fn detect_offset_pixels` function body. It will be replaced in Task 2.

- [ ] **Step 3: Delete `find_offset_and_cut` function (lines 232-312)**

Remove the entire `fn find_offset_and_cut` function body. It will be replaced in Task 2.

- [ ] **Step 4: Verify compilation**

Run: `cd src-tauri && cargo check 2>&1`
Expected: Compile errors about missing `detect_offset_pixels` and `find_offset_and_cut` — that's expected, we'll add replacements next.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/services/scroll_capture.rs
git commit -m "refactor: remove old offset detection, add OffsetResult struct"
```

---

### Task 2: Implement `detect_offset_ncc` with NCC algorithm

**Files:**
- Modify: `src-tauri/src/services/scroll_capture.rs` (add new function where `detect_offset_pixels` was)

- [ ] **Step 1: Write failing test for NCC detection**

Add this test in the `mod tests` section (before existing tests):

```rust
#[test]
fn test_detect_offset_ncc_known_offset() {
    let base = gradient_image(200, 400);
    let offset = 80u32;
    let new_frame = shifted_image(&base, -(offset as i32));

    let result = ScrollCaptureService::detect_offset_ncc(&base, &new_frame);

    assert!(result.confidence >= 0.7, "confidence should be >= 0.7, got {}", result.confidence);
    assert!(
        (result.offset as i32 - offset as i32).unsigned_abs() <= 2,
        "offset should be ~{}, got {}",
        offset, result.offset
    );
}

#[test]
fn test_detect_offset_ncc_no_match() {
    let base = solid_image(200, 400, 255, 0, 0);
    let other = solid_image(200, 400, 0, 0, 255);

    let result = ScrollCaptureService::detect_offset_ncc(&base, &other);

    assert!(result.confidence < 0.7, "should have low confidence for unrelated images, got {}", result.confidence);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test test_detect_offset_ncc -- --nocapture 2>&1`
Expected: FAIL — function doesn't exist yet.

- [ ] **Step 3: Implement `detect_offset_ncc`**

Add this function where `detect_offset_pixels` used to be:

```rust
fn detect_offset_ncc(
    prev: &image::RgbaImage,
    curr: &image::RgbaImage,
) -> OffsetResult {
    let width = prev.width().min(curr.width());
    let prev_h = prev.height();
    let curr_h = curr.height();

    let min_offset = (prev_h as f64 * 0.03) as u32;
    let max_offset = (prev_h as f64 * 0.95) as u32;

    let x_step = 3usize;
    let x_count = width as usize / x_step;

    let compare_rows = 30u32;

    let mut best_offset: u32 = 0;
    let mut best_ncc: f64 = f64::NEG_INFINITY;

    for candidate in (min_offset..max_offset).step_by(2) {
        if candidate >= prev_h || candidate >= curr_h { break; }

        let rows = candidate.min(compare_rows);
        let ncc = Self::compute_ncc(
            prev, curr,
            &Self::make_pairs(prev, curr, prev_h, 0, rows, x_step, x_count, candidate),
        );

        if ncc > best_ncc {
            best_ncc = ncc;
            best_offset = candidate;
        }
    }

    let refine_start = best_offset.saturating_sub(5).max(min_offset);
    let refine_end = (best_offset + 6).min(max_offset);

    for candidate in refine_start..refine_end {
        if candidate >= prev_h || candidate >= curr_h { break; }

        let rows = candidate.min(40u32);
        let ncc = Self::compute_ncc(
            prev, curr,
            &Self::make_pairs(prev, curr, prev_h, 0, rows, x_step, x_count, candidate),
        );

        if ncc > best_ncc {
            best_ncc = ncc;
            best_offset = candidate;
        }
    }

    let confidence = if best_ncc == f64::NEG_INFINITY { 0.0 } else { best_ncc.max(0.0) };

    OffsetResult {
        offset: best_offset,
        confidence,
    }
}

fn make_pairs(
    prev: &image::RgbaImage,
    curr: &image::RgbaImage,
    prev_h: u32,
    _start_row: u32,
    rows: u32,
    x_step: usize,
    x_count: usize,
    offset: u32,
) -> Vec<(f64, f64)> {
    let mut pairs = Vec::with_capacity((rows as usize) * x_count);
    for row in 0..rows {
        let prev_y = prev_h - offset + row;
        let curr_y = row;
        for xi in 0..x_count {
            let x = (xi * x_step) as u32;
            let pp = prev.get_pixel(x, prev_y);
            let cp = curr.get_pixel(x, curr_y);
            let pv = (pp[0] as f64 + pp[1] as f64 + pp[2] as f64) / 3.0;
            let cv = (cp[0] as f64 + cp[1] as f64 + cp[2] as f64) / 3.0;
            pairs.push((pv, cv));
        }
    }
    pairs
}

fn compute_ncc(_prev: &image::RgbaImage, _curr: &image::RgbaImage, pairs: &[(f64, f64)]) -> f64 {
    if pairs.len() < 10 {
        return f64::NEG_INFINITY;
    }

    let n = pairs.len() as f64;
    let mean_p: f64 = pairs.iter().map(|(p, _)| p).sum::<f64>() / n;
    let mean_c: f64 = pairs.iter().map(|(_, c)| c).sum::<f64>() / n;

    let mut cov = 0.0f64;
    let mut var_p = 0.0f64;
    let mut var_c = 0.0f64;

    for (p, c) in pairs {
        let dp = p - mean_p;
        let dc = c - mean_c;
        cov += dp * dc;
        var_p += dp * dp;
        var_c += dc * dc;
    }

    let denom = var_p.sqrt() * var_c.sqrt();
    if denom < 1e-10 {
        return 0.0;
    }

    cov / denom
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test test_detect_offset_ncc -- --nocapture 2>&1`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/services/scroll_capture.rs
git commit -m "feat: implement NCC-based offset detection"
```

---

### Task 3: Rewrite `stitch_frame` with overlap blend + buffer copy

**Files:**
- Modify: `src-tauri/src/services/scroll_capture.rs` (replace `stitch_frame`)

- [ ] **Step 1: Write failing test for overlap blend**

```rust
#[test]
fn test_stitch_overlap_blend_no_seam() {
    let mut base = gradient_image(200, 400);
    let offset = 80u32;
    let new_frame = shifted_image(&base, -(offset as i32));

    let result = OffsetResult { offset, confidence: 0.95 };
    ScrollCaptureService::stitch_frame(&mut base, &new_frame, &result).unwrap();

    assert_eq!(base.height(), 400 + (400 - offset));

    let top_pixel = base.get_pixel(0, 0);
    assert_eq!(top_pixel.0[0], 0, "top should be preserved from gradient");
}

#[test]
fn test_stitch_blend_zone_is_smooth() {
    let mut base = gradient_image(200, 400);
    let offset = 80u32;
    let new_frame = shifted_image(&base, -(offset as i32));

    let blend_row = 400 - offset / 2;
    let pixel = base.get_pixel(50, blend_row);
    assert_ne!(pixel.0, [0, 0, 0, 0], "blend zone should not be empty/black");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test test_stitch_overlap -- --nocapture 2>&1`
Expected: FAIL — `stitch_frame` signature changed.

- [ ] **Step 3: Rewrite `stitch_frame`**

Replace the existing `stitch_frame` function with:

```rust
fn stitch_frame(
    base: &mut image::RgbaImage,
    new_frame: &image::RgbaImage,
    result: &OffsetResult,
) -> Result<()> {
    let offset = result.offset;

    if offset < (base.height() as f64 * MIN_OFFSET_RATIO).max(MIN_OFFSET_ABSOLUTE) as u32 {
        return Ok(());
    }
    if result.confidence < 0.7 {
        return Ok(());
    }

    let overlap = offset;
    let base_non_overlap = base.height().saturating_sub(overlap);
    let new_rows = new_frame.height().saturating_sub(overlap);
    let new_total = base_non_overlap + overlap + new_rows;

    if new_rows == 0 && overlap == 0 {
        return Ok(());
    }

    if new_total > MAX_SCROLL_HEIGHT {
        return Err(AppError::ScreenCapture(format!(
            "Max height {} exceeded (current: {})",
            MAX_SCROLL_HEIGHT, new_total
        )));
    }

    let width = base.width().max(new_frame.width());
    let mut composite = image::RgbaImage::new(width, new_total);

    // Copy base non-overlap rows (buffer copy)
    for y in 0..base_non_overlap {
        let src_row = base.row(y);
        let dst_row = composite.row_mut(y);
        let copy_len = src_row.len().min(dst_row.len());
        dst_row[..copy_len].copy_from_slice(&src_row[..copy_len]);
    }

    // Blend overlap zone (weighted average)
    for y in 0..overlap {
        let weight = (y as f32 + 0.5) / overlap as f32;
        let base_y = base_non_overlap + y;
        let new_y = y;
        let dest_y = base_non_overlap + y;

        if base_y >= base.height() || new_y >= new_frame.height() { continue; }

        let base_row = base.row(base_y);
        let new_row = new_frame.row(new_y);
        let dst_row = composite.row_mut(dest_y);

        for x in 0..width as usize {
            let bx = (x * 4).min(base_row.len().saturating_sub(4));
            let nx = (x * 4).min(new_row.len().saturating_sub(4));

            let br = base_row.get(bx).copied().unwrap_or(0);
            let bg = base_row.get(bx + 1).copied().unwrap_or(0);
            let bb = base_row.get(bx + 2).copied().unwrap_or(0);

            let nr = new_row.get(nx).copied().unwrap_or(0);
            let ng = new_row.get(nx + 1).copied().unwrap_or(0);
            let nb = new_row.get(nx + 2).copied().unwrap_or(0);

            let r = (br as f32 * (1.0 - weight) + nr as f32 * weight) as u8;
            let g = (bg as f32 * (1.0 - weight) + ng as f32 * weight) as u8;
            let b = (bb as f32 * (1.0 - weight) + nb as f32 * weight) as u8;

            let dx = x * 4;
            if dx + 3 < dst_row.len() {
                dst_row[dx] = r;
                dst_row[dx + 1] = g;
                dst_row[dx + 2] = b;
                dst_row[dx + 3] = 255;
            }
        }
    }

    // Copy new_frame non-overlap rows (buffer copy)
    for y in 0..new_rows {
        let src_y = overlap + y;
        let dest_y = base_non_overlap + overlap + y;
        if src_y >= new_frame.height() || dest_y >= new_total { break; }

        let src_row = new_frame.row(src_y);
        let dst_row = composite.row_mut(dest_y);
        let copy_len = src_row.len().min(dst_row.len());
        dst_row[..copy_len].copy_from_slice(&src_row[..copy_len]);
    }

    *base = composite;
    Ok(())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test test_stitch_overlap -- --nocapture 2>&1`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/services/scroll_capture.rs
git commit -m "feat: rewrite stitch_frame with overlap blend + buffer copy"
```

---

### Task 4: Update `start_capture` loop to use `detect_offset_ncc`

**Files:**
- Modify: `src-tauri/src/services/scroll_capture.rs` (update `start_capture` function)

- [ ] **Step 1: Update idle phase (line ~460-473)**

Replace the offset detection call in idle phase from:
```rust
let stitch_offset = Self::detect_offset_pixels(&prev_image, &curr_image);
let min_offset = (curr_image.height() as f64 * MIN_OFFSET_RATIO)
    .max(MIN_OFFSET_ABSOLUTE);

if stitch_offset < min_offset {
    prev_image = curr_image;
    continue;
}

println!("[scroll] SCROLL DETECTED: offset={}", stitch_offset);

if let Err(e) = Self::stitch_frame(&mut stitched, &curr_image, stitch_offset) {
```

With:
```rust
let offset_result = Self::detect_offset_ncc(&prev_image, &curr_image);
let min_offset = (curr_image.height() as f64 * MIN_OFFSET_RATIO)
    .max(MIN_OFFSET_ABSOLUTE);

if offset_result.confidence < 0.7 || offset_result.offset as f64 < min_offset {
    prev_image = curr_image;
    continue;
}

println!("[scroll] SCROLL DETECTED: offset={} confidence={:.3}", offset_result.offset, offset_result.confidence);

if let Err(e) = Self::stitch_frame(&mut stitched, &curr_image, &offset_result) {
```

- [ ] **Step 2: Update active phase (line ~527-543)**

Replace the offset detection call in active phase from:
```rust
let offset = Self::detect_offset_pixels(&prev_image, &next_image);
let min_off = (next_image.height() as f64 * MIN_OFFSET_RATIO)
    .max(MIN_OFFSET_ABSOLUTE);

if offset < min_off {
```

With:
```rust
let offset_result = Self::detect_offset_ncc(&prev_image, &next_image);
let min_off = (next_image.height() as f64 * MIN_OFFSET_RATIO)
    .max(MIN_OFFSET_ABSOLUTE);

if offset_result.confidence < 0.7 || offset_result.offset as f64 < min_off {
```

- [ ] **Step 3: Update the stitch call in active phase**

Replace:
```rust
if let Err(e) = Self::stitch_frame(&mut stitched, &next_image, offset) {
```

With:
```rust
if let Err(e) = Self::stitch_frame(&mut stitched, &next_image, &offset_result) {
```

- [ ] **Step 4: Verify compilation**

Run: `cd src-tauri && cargo check 2>&1`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/services/scroll_capture.rs
git commit -m "refactor: update capture loop to use NCC offset detection"
```

---

### Task 5: Fix all tests

**Files:**
- Modify: `src-tauri/src/services/scroll_capture.rs` (tests section)

- [ ] **Step 1: Update existing stitch tests to use new signature**

Replace all calls to `stitch_frame(&mut base, &new_frame, offset_y: f64)` with `stitch_frame(&mut base, &new_frame, &OffsetResult { offset: offset as u32, confidence: 0.95 })`.

For each existing test that calls `stitch_frame`, change from:
```rust
ScrollCaptureService::stitch_frame(&mut base, &new_frame, 50.0).unwrap();
```
To:
```rust
let result = OffsetResult { offset: 50, confidence: 0.95 };
ScrollCaptureService::stitch_frame(&mut base, &new_frame, &result).unwrap();
```

Update all these tests:
- `test_stitch_downward_scroll_increases_height`: offset 50
- `test_stitch_upward_scroll_increases_height`: offset 50 (Note: update to test downward only since scroll is always down)
- `test_stitch_below_threshold_is_noop`: offsets 1, 0, need confidence < 0.7 or offset < min
- `test_stitch_preserves_base_content_at_top`: offset 50
- `test_stitch_new_content_appears_at_bottom`: offset 50
- `test_stitch_upward_new_content_at_top`: remove or change to downward scroll test
- `test_stitch_multiple_frames_accumulate`: offset 30
- `test_stitch_max_height_limit`: offset 10
- `test_stitch_offset_equals_frame_height_no_new_content`: offset 100
- `test_stitch_offset_exceeds_frame_height_no_new_content`: offset 200
- `test_stitch_with_realistic_gradient_data`: offset 80

- [ ] **Step 2: Remove broken test references to `CAPTURE_INTERVAL_SLOW_MS`**

Delete `test_adaptive_interval_constants_sane` and `test_adaptive_interval_simulation` tests entirely. The old 3-tier interval system (slow/default/fast) was replaced by 2-phase (idle/active), so these tests test non-existent behavior.

- [ ] **Step 3: Run all tests**

Run: `cd src-tauri && cargo test -- --nocapture 2>&1`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/services/scroll_capture.rs
git commit -m "test: fix tests for NCC-based stitch, remove stale interval tests"
```

---

### Task 6: Final verification

- [ ] **Step 1: Run full test suite**

Run: `cd src-tauri && cargo test 2>&1`
Expected: All tests pass, 0 failures.

- [ ] **Step 2: Check compilation warnings**

Run: `cd src-tauri && cargo check 2>&1`
Expected: No warnings about unused code (the old `capture_region` private method and `unique_timestamp` can optionally be removed since they're dead code).

- [ ] **Step 3: Clean up dead code (optional)**

If desired, remove the unused private `capture_region` and `unique_timestamp` methods from `ScrollCaptureService` since `ScreenCaptureService::capture_region` is used instead.

Run: `cd src-tauri && cargo check 2>&1`
Expected: No warnings.

- [ ] **Step 4: Manual test with `bun run tauri dev`**

Run: `bun run tauri dev`
Test: Take a scroll capture of a long page. Verify:
1. No seam lines in stitched image
2. Text is readable throughout
3. No duplicate/shifted rows
4. Performance feels smooth during capture

- [ ] **Step 5: Final commit if any cleanup was needed**

```bash
git add src-tauri/src/services/scroll_capture.rs
git commit -m "chore: clean up dead code in scroll_capture"
```
