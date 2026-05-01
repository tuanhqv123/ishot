# Scroll Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add scroll capture (long screenshot) functionality that captures scrolling content and copies to clipboard.

**Architecture:** Wire existing Rust scroll capture backend to frontend. Add "Scroll" button to toolbar, floating "Stop" button during capture, and event listeners for results.

**Tech Stack:** Rust (Tauri), React/TypeScript, macOS Vision framework

---

### Task 1: Register scroll capture backend in main.rs

**Files:**
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add ScrollCaptureState import and managed state**

Add after line 16 (`use base64::...`):
```rust
use crate::services::scroll_capture::ScrollCaptureState;
```

Add after line 11 (`use tauri::...`), modify the existing import to include `Manager`:
```rust
use tauri::{Emitter, Listener, Manager};
```
(Already present, verify)

- [ ] **Step 2: Add `.manage()` to builder chain**

Find this line (~line 207):
```rust
tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
```

Change to:
```rust
tauri::Builder::default()
    .manage(std::sync::Arc::new(std::sync::Mutex::new(ScrollCaptureState::default())))
    .plugin(tauri_plugin_shell::init())
```

- [ ] **Step 3: Add scroll capture commands to invoke_handler**

Find the `invoke_handler` block (~line 362-374):
```rust
.invoke_handler(tauri::generate_handler![
    commands::screenshot::capture_screen,
    commands::screenshot::capture_region,
    commands::screenshot::get_display_bounds,
    commands::screenshot::get_monitors_info,
    commands::window::show_overlay,
    commands::window::hide_overlay,
    commands::file::copy_to_clipboard,
    commands::file::copy_text_to_clipboard,
    commands::file::save_to_file,
    commands::ocr::perform_ocr,
    commands::translate::translate_text,
])
```

Change to:
```rust
.invoke_handler(tauri::generate_handler![
    commands::screenshot::capture_screen,
    commands::screenshot::capture_region,
    commands::screenshot::get_display_bounds,
    commands::screenshot::get_monitors_info,
    commands::window::show_overlay,
    commands::window::hide_overlay,
    commands::file::copy_to_clipboard,
    commands::file::copy_text_to_clipboard,
    commands::file::save_to_file,
    commands::ocr::perform_ocr,
    commands::translate::translate_text,
    commands::scroll_capture::start_scroll_capture,
    commands::scroll_capture::stop_scroll_capture,
    commands::scroll_capture::cancel_scroll_capture,
    commands::scroll_capture::get_scroll_capture_state,
])
```

- [ ] **Step 4: Verify compilation**

Run: `cd /Users/tuantran/WorkSpace/ishot/src-tauri && cargo check`
Expected: Compiles with existing warnings only (scroll_capture warnings may disappear)

---

### Task 2: Add scroll state and event listeners to App.tsx

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add scroll state variables**

After line 70 (`const [lockedByOther, setLockedByOther] = useState(false);`), add:
```tsx
const [scrollCapturing, setScrollCapturing] = useState(false);
```

- [ ] **Step 2: Add scroll capture event listeners**

After line 320 (the `cancel-capture` listener), add:
```tsx
// Scroll capture result
useEffect(() => {
  const unlisten = listen("scroll-capture-result", async (event) => {
    const payload = event.payload as { data: number[]; width: number; height: number };
    if (payload.data) {
      await invoke("copy_to_clipboard", { imageBytes: payload.data });
    }
    setScrollCapturing(false);
    await cancelCapture();
  });
  return () => { unlisten.then(fn => fn()); };
}, [cancelCapture]);

// Scroll capture error
useEffect(() => {
  const unlisten = listen("scroll-capture-error", async (event) => {
    console.error("[scroll] capture error:", event.payload);
    setScrollCapturing(false);
    await cancelCapture();
  });
  return () => { unlisten.then(fn => fn()); };
}, [cancelCapture]);
```

- [ ] **Step 3: Update keyboard handler for Escape during scroll capture**

Find line 337:
```tsx
if (e.key === "Escape") cancelCapture();
```

Change to:
```tsx
if (e.key === "Escape") {
  if (scrollCapturing) {
    await invoke("cancel_scroll_capture");
  }
  cancelCapture();
}
```

- [ ] **Step 4: Update deps array for keyboard handler**

Find line 350:
```tsx
}, [cancelCapture, selectedText, selectedAnnotation, deleteSelectedAnnotation, editingTextId, handleUndo]);
```

Change to:
```tsx
}, [cancelCapture, selectedText, selectedAnnotation, deleteSelectedAnnotation, editingTextId, handleUndo, scrollCapturing]);
```

---

### Task 3: Add Scroll button to toolbar and handleStartScroll function

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Import Scroll icon**

Find line 5-8:
```tsx
import {
  Square, Circle, ArrowRight, Minus, Pencil, Grid3X3,
  ScanText, Type, Download, X, Check, Undo2, Languages
} from "lucide-react";
```

Change to:
```tsx
import {
  Square, Circle, ArrowRight, Minus, Pencil, Grid3X3,
  ScanText, Type, Download, X, Check, Undo2, Languages, Scroll
} from "lucide-react";
```

- [ ] **Step 2: Add handleStartScroll function**

After line 295 (before `handleToolChange`), add:
```tsx
const handleStartScroll = useCallback(async () => {
  if (!selection) return;
  const dc = findDisplay();
  if (!dc) return;
  const s = dc.monitor.scale_factor;
  // Convert selection coords (window-relative) to screen coords
  const screenX = (selection.x + monitors[myMonitorIndex].x) * s;
  const screenY = (selection.y + monitors[myMonitorIndex].y) * s;
  const screenW = selection.width * s;
  const screenH = selection.height * s;
  setScrollCapturing(true);
  setTool(null);
  try {
    await invoke("start_scroll_capture", {
      x: screenX,
      y: screenY,
      width: screenW,
      height: screenH,
    });
  } catch (e) {
    console.error("[scroll] start failed:", e);
    setScrollCapturing(false);
  }
}, [selection, findDisplay, monitors, myMonitorIndex]);
```

- [ ] **Step 3: Add Scroll button to toolbar**

Find the toolbar Row 1 (~line 777-778):
```tsx
<ToolBtn active={tool === "text"} onClick={() => handleToolChange("text")} title="OCR">{ocrLoading ? <span style={{fontSize:11}}>...</span> : <ScanText size={18} />}</ToolBtn>
<ToolBtn onClick={handleTranslate} title="Translate selection">{translateLoading ? <span style={{fontSize:11}}>...</span> : <Languages size={18} />}</ToolBtn>
```

Change to:
```tsx
<ToolBtn active={tool === "text"} onClick={() => handleToolChange("text")} title="OCR">{ocrLoading ? <span style={{fontSize:11}}>...</span> : <ScanText size={18} />}</ToolBtn>
<ToolBtn onClick={handleStartScroll} title="Scroll capture" disabled={scrollCapturing}><Scroll size={18} /></ToolBtn>
<ToolBtn onClick={handleTranslate} title="Translate selection">{translateLoading ? <span style={{fontSize:11}}>...</span> : <Languages size={18} />}</ToolBtn>
```

---

### Task 4: Add floating Stop button and hide toolbar during capture

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Hide toolbar during scroll capture**

Find the toolbar section (~line 767-784, the entire `return (<>` block with toolbars):

Wrap the toolbar render with a condition. Find:
```tsx
return (<>
  {/* Row 1: Tools + actions */}
  <div style={{ ...barStyle, top: row1Top }}>
```

Change to:
```tsx
return (<>
  {!scrollCapturing && (<>
  {/* Row 1: Tools + actions */}
  <div style={{ ...barStyle, top: row1Top }}>
```

Find the closing of Row 2 (~line 824):
```tsx
              )}
            </>);
          })()}
```

Change to:
```tsx
              )}
  </>)}
  {/* Stop button during scroll capture */}
  {scrollCapturing && (
    <div style={{ position: "fixed", bottom: 20, right: 20, zIndex: 200 }}>
      <ToolBtn onClick={async () => {
        await invoke("stop_scroll_capture");
      }} style={{ color: "#e00", background: "rgba(255,255,255,0.95)" }} title="Stop and copy">
        <Square size={18} />
      </ToolBtn>
    </div>
  )}
            </>);
          })()}
```

- [ ] **Step 2: Run and test**

Run: `bun run tauri dev`
Expected: App starts, "Scroll" button appears in toolbar after selecting region.

---

### Task 5: Integration testing

- [ ] **Step 1: Test basic flow**

1. Press hotkey → overlay appears
2. Select a region → toolbar appears
3. Click "Scroll" button
4. Verify: toolbar hides, Stop button appears in bottom-right
5. Scroll in a browser window within the selected region
6. Click Stop button
7. Verify: image copied to clipboard, overlay closes
8. Paste clipboard → verify stitched image

- [ ] **Step 2: Test cancel flow**

1. Press hotkey → overlay appears
2. Select a region → toolbar appears
3. Click "Scroll" button
4. Press Escape
5. Verify: overlay closes, nothing copied

- [ ] **Step 3: Test error handling**

1. Try scroll capture on an empty region
2. Verify: error logged, overlay closes gracefully
