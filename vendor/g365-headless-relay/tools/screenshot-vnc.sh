#!/bin/bash
# screenshot-vnc.sh — Capture the VNC display to a PNG file
#
# Usage:
#   ./tools/screenshot-vnc.sh              # save to /tmp/vnc_screenshot.png
#   ./tools/screenshot-vnc.sh /path/out.png  # custom path

OUTPUT="${1:-/tmp/vnc_screenshot.png}"
DISPLAY_NUM="${DISPLAY:-:99}"

if ! command -v import &>/dev/null; then
  echo "❌ ImageMagick 'import' not found. Install with: sudo apt install imagemagick"
  exit 1
fi

if ! pgrep -x Xvfb >/dev/null 2>&1; then
  echo "❌ Xvfb not running. Start VNC first:"
  echo "   ./start-vnc.sh"
  exit 1
fi

if ! DISPLAY=$DISPLAY_NUM import -window root "$OUTPUT" 2>/dev/null; then
  echo "❌ Screenshot failed. Is Xvfb running on display $DISPLAY_NUM?"
  exit 1
fi

echo "✅ Screenshot saved: $OUTPUT"
echo "   Size: $(stat -c%s "$OUTPUT") bytes"
echo "   Dimensions: $(identify -format '%wx%h' "$OUTPUT" 2>/dev/null || echo 'unknown')"
