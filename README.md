<div align="center">

# iShot

**A fast, native macOS screenshot, annotation & screen-recording tool — free and open source.**

Capture, mark up, OCR, translate, scroll-capture, and record your screen (with mic + camera) — all from the menu bar.

[![Latest release](https://img.shields.io/github/v/release/tuanhqv123/ishot?label=release&color=0a84ff)](https://github.com/tuanhqv123/ishot/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/tuanhqv123/ishot/total?color=30d158&label=downloads)](https://github.com/tuanhqv123/ishot/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%2012%2B-black?logo=apple)](https://github.com/tuanhqv123/ishot/releases/latest)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24c8db)](https://v2.tauri.app/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

[**⬇ Download**](https://github.com/tuanhqv123/ishot/releases/latest) · [Website](https://ishot-landingpage.vercel.app) · [Report a bug](https://github.com/tuanhqv123/ishot/issues)

</div>

---

## Features

- **📸 Screenshot capture** — global shortcut (default `Cmd+Shift+A`, customizable), works across all monitors.
- **🎥 Screen recording** — record your screen with **microphone** and a **round camera bubble** (Loom-style), then trim and save. No extra app.
- **✏️ Annotations** — rectangle, oval, arrow, line, freehand draw, and rich text boxes (per-run color, size, bold, underline) with adjustable sloppiness.
- **🌫️ Blur / mosaic** — pixelate sensitive content before you share.
- **🔤 OCR** — extract text from any region using the native macOS Vision framework, multi-language.
- **🔳 QR & barcodes** — the same OCR pass also decodes QR codes and barcodes, pulling out links and **deep links** in one scan.
- **🌐 Translate** — OCR + translate the selection into 12+ languages (your own AI key, or free fallback).
- **🖼️ Screenshot backgrounds** — drop your shot onto a gradient, solid color, or your **current desktop wallpaper** with adjustable corner radius, padding, and shadow.
- **📜 Scroll capture** — capture long pages by scrolling; frames are stitched automatically.
- **🤖 AI chat** — ask anything about a screenshot (OCR + any OpenAI-compatible model, streaming Markdown).
- **📋 Clipboard history** — Spotlight-style panel to browse and restore everything you've copied.
- **⌨️ Custom shortcuts** + **menu-bar app** with optional launch at login.

## Download

Grab the latest signed build from the [**Releases**](https://github.com/tuanhqv123/ishot/releases/latest) page (or the [website](https://ishot-landingpage.vercel.app)).

The app is **signed with a Developer ID and notarized by Apple**, so it runs without Gatekeeper warnings. Built-in auto-updates: pick **Check for Updates…** from the menu-bar icon.

## Requirements

- macOS 12 (Monterey) or later
- Apple Silicon (M-series) — `aarch64`
- **Screen Recording** permission (prompted on first capture/record — needed for capture, wallpaper backgrounds, and recording)

## Development

### Prerequisites

- [Rust](https://rustup.rs/) (stable) · [Bun](https://bun.sh/) · Xcode Command Line Tools (`xcode-select --install`)

### Setup & run

```bash
git clone https://github.com/tuanhqv123/ishot.git
cd ishot
bun install
bun run tauri dev
```

### Build

```bash
bun run tauri build
# → src-tauri/target/release/bundle/dmg/iShot_<version>_aarch64.dmg
```

## Tech stack

| Layer | Technology |
|-------|-----------|
| Framework | Tauri 2.0 (Rust + WKWebView) |
| Frontend | React + TypeScript + Vite |
| Icons | [Phosphor Icons](https://phosphoricons.com/) |
| Screenshot | `screencapture` + Core Graphics |
| Recording | AVFoundation (`AVCaptureScreenInput`, mic, camera) |
| Wallpaper capture | ScreenCaptureKit (`SCScreenshotManager`) |
| OCR / QR | macOS Vision (`VNRecognizeTextRequest` + `VNDetectBarcodesRequest`) |
| Translate | User AI key (OpenAI-compatible) → Google fallback |
| Clipboard | `arboard` |

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+A` | Take screenshot (customizable) |
| `Escape` | Cancel capture |
| `Cmd+Z` | Undo last annotation |
| `Cmd+C` | Copy (OCR text, or finish + copy while annotating) |
| `Delete` | Delete selected annotation |
| `Shift` (hold) | Constrain shapes / snap angles |

## Support

If iShot saves you a few clicks every day, a coffee keeps it going:

- ⭐ **Star this repo** — it genuinely helps.
- ☕ [**Ko-fi**](https://ko-fi.com/tuantran1849) (international) · 🇻🇳 VietQR (in-app: Settings → Support → Vietnam)

## License

[MIT](./LICENSE) © [Tuan Tran](https://github.com/tuanhqv123)
