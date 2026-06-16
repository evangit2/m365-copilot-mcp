#!/bin/bash
# Standalone script to open Chrome on VNC display for M365 sign-in
# Usage: adjust PROFILE_DIR and CHROME_BIN for your system

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${PROFILE_DIR:-$SCRIPT_DIR/profile}"
CHROME="${CHROME_BIN:-$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome}"

export DISPLAY=:99

# Kill any existing chrome using this profile
pkill -f "chrome.*$PROFILE" 2>/dev/null || true
sleep 1

# Launch Chrome at M365 Copilot
exec "$CHROME" \
  --no-first-run \
  --no-default-browser-check \
  --disable-blink-features=AutomationControlled \
  --disable-features=Translate \
  --disable-background-networking \
  --disable-sync \
  --disable-extensions \
  --password-store=basic \
  --use-mock-keychain \
  --window-size=1280,720 \
  --window-position=0,0 \
  --user-data-dir="$PROFILE" \
  "https://m365.cloud.microsoft/chat?auth=2"
