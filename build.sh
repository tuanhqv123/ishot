#!/bin/bash
# Build iShot for macOS
# Using ad-hoc signing (-) so users see "cannot verify" dialog with Open button
# instead of "damaged" error

set -e

echo "Building iShot..."

# Clean previous build
rm -rf src-tauri/target/release/bundle

# Build with Tauri (ad-hoc signing configured in tauri.conf.json)
bun run tauri build

echo ""
echo "Build complete!"
echo "DMG: src-tauri/target/release/bundle/dmg/iShot_0.1.0_aarch64.dmg"
