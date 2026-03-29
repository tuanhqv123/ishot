# iShot

A lightweight screenshot and annotation tool for macOS, built with [Tauri 2.0](https://v2.tauri.app/) (Rust + React/TypeScript).

## Features

- **Screenshot capture** with global shortcut (default `Cmd+Shift+A`, customizable)
- **Multi-monitor support** — overlay and capture work across all connected displays
- **Region selection** — drag to select any area, hold `Shift` for square/circle/snap angles
- **Annotation tools** — rectangle, oval, arrow, line, freehand draw, textbox
- **Blur/mosaic** — pixelate sensitive content with adjustable strength
- **OCR** — extract text from the selected region using macOS Vision framework
- **Translate** — OCR + translate selected region (auto-detect language)
- **Textbox** — add text with customizable font size, bold, underline, color
- **Undo** — `Cmd+Z` to undo last annotation
- **Copy / Save** — copy to clipboard or save as PNG
- **Menu bar app** — runs in the menu bar with optional launch at login
- **Custom stroke width & colors** — 8 color presets + adjustable line thickness

## Download

Get the latest release from the [Releases](https://github.com/tuanhqv123/ishot/releases) page.

> **Note**: The app is signed with ad-hoc signature (not notarized). On first launch, right-click the app and select "Open" to bypass Gatekeeper.

## Requirements

- macOS 10.15 (Catalina) or later
- Apple Silicon (M1/M2/M3/M4) — `aarch64` build
- Screen Recording permission (prompted on first launch)

## Development

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Bun](https://bun.sh/) (package manager)
- Xcode Command Line Tools (`xcode-select --install`)

### Setup

```bash
git clone https://github.com/tuanhqv123/ishot.git
cd ishot
bun install
```

### Run

```bash
bun run tauri dev
```

### Build

```bash
bun run tauri build
```

Output: `src-tauri/target/release/bundle/dmg/iShot_<version>_aarch64.dmg`

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Tauri 2.0 |
| Backend | Rust |
| Frontend | React + TypeScript |
| Build | Vite |
| Icons | [Lucide React](https://lucide.dev/) |
| Screen Capture | macOS `screencapture` CLI |
| OCR | macOS Vision framework (Swift) |
| Translation | Google Translate API |
| Clipboard | `arboard` crate |

## Architecture

```
src-tauri/src/
  main.rs              # App entry, tray icon, shortcuts, per-monitor overlay windows
  commands/            # Tauri IPC commands (screenshot, window, file, ocr, translate)
  services/            # Business logic (screen capture, OCR, translate)

src/
  App.tsx              # Main UI — selection, annotations, toolbar, OCR, translate
  styles.css           # Global styles
```

**Multi-monitor**: Each monitor gets its own transparent overlay window. The main overlay handles selection and annotation; secondary overlays show dim effect only. Windows synchronize via Tauri events (`selection-locked`, `cancel-capture`).

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+A` | Take screenshot (customizable) |
| `Escape` | Cancel capture |
| `Cmd+Z` | Undo last annotation |
| `Cmd+C` | Copy selected OCR text |
| `Delete` | Delete selected annotation |
| `Shift` (hold) | Constrain shapes (square/circle/snap angles) |

## License

MIT
