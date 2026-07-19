#!/usr/bin/env bash
# Build + install the Tianshu Local Bridge menu-bar app (macOS).
#
# Compiles a tiny native SwiftUI/AppKit menu-bar app (no Electron, no
# extra runtime) that wraps the `tsbridge` CLI: a menu-bar icon with
# Start/Stop + Settings (server / token / browser engine / headless).
#
# Usage:
#   bash app/install-app.sh            # build → install to ~/Applications
#   bash app/install-app.sh --run      # also launch it
#   APP_DEST=/Applications bash app/install-app.sh   # install system-wide
#
# Requirements: macOS, Xcode command line tools (swiftc), and the
# tsbridge CLI (`npm i -g @tianshu-ai/local-bridge`).

set -euo pipefail

APP_NAME="Tianshu Bridge"
BUNDLE_ID="ai.tianshu.local-bridge"
DEST="${APP_DEST:-$HOME/Applications}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWIFT_SRC="$SRC_DIR/TianshuBridge.swift"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "error: this app is macOS-only." >&2
  exit 1
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "error: swiftc not found. Install Xcode command line tools:" >&2
  echo "  xcode-select --install" >&2
  exit 1
fi
if ! command -v tsbridge >/dev/null 2>&1; then
  echo "note: 'tsbridge' not on PATH yet. Install it with:" >&2
  echo "  npm i -g @tianshu-ai/local-bridge" >&2
  echo "(the app resolves tsbridge from common install locations at runtime.)" >&2
fi

APP_DIR="$DEST/$APP_NAME.app"
MACOS_DIR="$APP_DIR/Contents/MacOS"
RES_DIR="$APP_DIR/Contents/Resources"

echo "→ Building $APP_NAME.app …"
rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RES_DIR"

# Info.plist — LSUIElement=true keeps it out of the Dock (menu bar only).
cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>TianshuBridge</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

echo "→ Compiling Swift (menu-bar app) …"
swiftc -O -o "$MACOS_DIR/TianshuBridge" "$SWIFT_SRC" \
  -framework AppKit -framework Foundation

# Ad-hoc code sign so Gatekeeper lets a locally-built app run.
codesign --force --deep --sign - "$APP_DIR" >/dev/null 2>&1 || \
  echo "note: ad-hoc codesign failed (app still runs; right-click → Open on first launch)."

echo "✓ Installed: $APP_DIR"
echo ""
echo "Open it from $DEST (or Spotlight: “$APP_NAME”). It lives in the menu"
echo "bar — click the bolt icon → Settings to set your server URL + token,"
echo "then Start. First launch: right-click the app → Open to bypass"
echo "Gatekeeper (unsigned local build)."

if [[ "${1:-}" == "--run" ]]; then
  echo "→ Launching …"
  open "$APP_DIR"
fi
