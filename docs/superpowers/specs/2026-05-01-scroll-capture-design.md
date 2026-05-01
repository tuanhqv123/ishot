# Scroll Capture Design

**Date:** 2026-05-01
**Status:** Draft

## Problem
Add scroll capture (long screenshot) functionality to iShot, allowing users to capture scrolling content like webpages, documents, and chat conversations.

## User Flow

```
1. User presses hotkey → overlay appears with all monitors
2. User selects a region → toolbar appears (current behavior)
3. User clicks "Scroll" button in toolbar
4. Overlay stays visible, selection border remains (same style)
5. A floating "Stop" button appears (bottom-right corner)
6. User scrolls anywhere on screen (mouse works normally)
7. User clicks "Stop" → stitched image copied to clipboard → overlay closes
8. User can also press Escape to cancel
```

## Architecture

### Backend (Rust - already exists, just needs wiring)

**Existing code:** `src-tauri/src/services/scroll_capture.rs`
- `ScrollCaptureService::start_capture()` - captures region, detects scroll offset via Vision, stitches frames
- `ScrollCaptureService::stop_capture()` - stops and returns final image
- `ScrollCaptureService::cancel_capture()` - stops without result
- Vision framework (Swift JIT) for offset detection between frames
- Stitching with overlap blending

**Existing commands:** `src-tauri/src/commands/scroll_capture.rs`
- `start_scroll_capture(x, y, width, height)` - starts capture loop in background thread
- `stop_scroll_capture()` - stops and returns result
- `cancel_scroll_capture()` - cancels without result
- `get_scroll_capture_state()` - returns is_capturing boolean

**What needs to change:**
1. Register `ScrollCaptureState` in Tauri's managed state (`main.rs`)
2. Register scroll capture commands in `invoke_handler` (`main.rs`)

**Events emitted by backend:**
- `scroll-capture-progress` - `{ current_height, max_height, frame_count }`
- `scroll-capture-result` - `{ data: Vec<u8>, width, height }` (PNG bytes)
- `scroll-capture-error` - error message string

### Frontend (React/TypeScript - App.tsx)

**New state:**
```typescript
type ScrollState = "idle" | "capturing";
const [scrollState, setScrollState] = useState<ScrollState>("idle");
```

**UI changes:**

1. **Toolbar - new "Scroll" button**
   - Added to row 1, between OCR and Translate buttons
   - Icon: `Scroll` from lucide-react (or custom icon)
   - Only visible when `stage === "editing"` and `scrollState === "idle"`

2. **Floating "Stop" button**
   - Position: bottom-right corner, `position: fixed`, 16px margin
   - Style: matches existing toolbar button style (32x32, rounded, white bg, shadow)
   - Icon: `Square` (stop icon) from lucide-react
   - Color: red `#e00` (matches cancel button)
   - Only visible when `scrollState === "capturing"`

3. **Selection border during capture**
   - Keep existing style: `1px solid #fff` + `boxShadow: 0 0 0 1px rgba(0,0,0,0.3)`
   - No color change, no pulsing - consistent with current selection

4. **During capture:**
   - Hide all other toolbar buttons (tools, undo, save, done, cancel)
   - Show only "Stop" button
   - User can still interact with screen normally
   - Overlay stays visible with screenshot + selection

**Event listeners:**
```typescript
listen("scroll-capture-result", (event) => {
  const { data, width, height } = event.payload;
  invoke("copy_to_clipboard", { imageBytes: data });
  cancelCapture();
});

listen("scroll-capture-error", (event) => {
  console.error("Scroll capture failed:", event.payload);
  cancelCapture();
});
```

**Keyboard handling:**
- `Escape` during capture → `cancel_scroll_capture()` → `cancelCapture()`

### Data Flow

```
[User clicks "Scroll"] 
  → invoke("start_scroll_capture", { x, y, width, height })
  → setScrollState("capturing")
  → Backend starts capture loop in background thread
    → Captures region repeatedly
    → Uses Vision to detect scroll offset
    → Stitches frames together
    → Emits "scroll-capture-progress" (optional, no UI)
  
[User clicks "Stop"]
  → invoke("stop_scroll_capture")
  → Backend returns stitched PNG
  → invoke("copy_to_clipboard", { imageBytes })
  → cancelCapture() → closes overlay

[User presses Escape]
  → invoke("cancel_scroll_capture")
  → cancelCapture() → closes overlay
```

## Error Handling

| Error | Handling |
|-------|----------|
| Screen recording permission denied | Show alert, close overlay |
| Vision offset detection fails | Log error, continue capturing |
| Stitching fails | Log error, continue with last good state |
| Max height exceeded (20000px) | Auto-stop, copy what was captured |
| Capture region invalid | Show error toast, close overlay |

## Constraints

- Max scroll height: 20,000px (existing constant)
- Auto-stop after 600ms of no scroll activity (existing behavior, but user has Stop button for manual control)
- Uses macOS `screencapture -C -R` for region capture
- Vision framework requires macOS 10.15+

## Files Modified

| File | Changes |
|------|---------|
| `src-tauri/src/main.rs` | Add ScrollCaptureState to managed state, register scroll commands |
| `src/App.tsx` | Add scroll state, Scroll button, Stop button, event listeners |
| `src-tauri/src/commands/mod.rs` | Add scroll_capture module export (if missing) |
