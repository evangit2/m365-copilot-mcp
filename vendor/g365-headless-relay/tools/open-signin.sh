#!/bin/bash
# open-signin.sh — Launch Chrome on VNC display for M365 interactive sign-in
#
# Usage:
#   ./tools/open-signin.sh           # launch and keep open
#   ./tools/open-signin.sh --kill      # kill existing sign-in browser
#
# After signing in via VNC, Ctrl+C or close the terminal to close Chrome.
# The relay's ./profile/ directory will have the authenticated session.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE_DIR="${PROFILE_DIR:-$SCRIPT_DIR/../profile}"
CHROME="${CHROME_BIN:-$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome}"

if [[ "$1" == "--kill" ]]; then
  echo "Killing sign-in browser..."
  pkill -9 -f "chrome.*$PROFILE_DIR" 2>/dev/null || true
  rm -f "$PROFILE_DIR"/SingletonLock "$PROFILE_DIR"/SingletonSocket* 2>/dev/null
  echo "Done"
  exit 0
fi

if [[ ! -x "$CHROME" ]]; then
  echo "❌ Chrome not found at $CHROME"
  echo "   Set CHROME_BIN to your Chromium binary path"
  exit 1
fi

# Detect VNC display
if [[ -z "$DISPLAY" ]]; then
  if pgrep -x Xvfb >/dev/null 2>&1; then
    export DISPLAY=:99
    echo "ℹ️  Using Xvfb display :99"
  else
    echo "❌ No X11 display found. Start VNC first:"
    echo "   ./start-vnc.sh"
    exit 1
  fi
fi

# Kill any existing chrome using this profile to avoid lock conflicts
echo "Cleaning up existing Chrome processes for this profile..."
pkill -9 -f "chrome.*$PROFILE_DIR" 2>/dev/null || true
sleep 1
rm -f "$PROFILE_DIR"/SingletonLock "$PROFILE_DIR"/SingletonSocket* 2>/dev/null

echo ""
echo "🚀 Launching Chrome for M365 sign-in on display $DISPLAY"
echo "   Profile: $PROFILE_DIR"
echo ""
echo "📋 Sign-in steps:"
echo "   1. Open VNC: http://$(hostname -I | awk '{print $1}'):6080/vnc.html"
echo "   2. Enter your M365 email → Next"
echo "   3. Enter password → Next"
echo "   4. Complete Duo MFA (push/SMS/call)"
echo "   5. Wait for m365.cloud.microsoft/chat to load"
echo "   6. Close this terminal or press Ctrl+C"
echo ""
echo "   Chrome PID will appear below. Keep this terminal open."
echo ""

export DISPLAY
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
  --user-data-dir="$PROFILE_DIR" \
  "https://m365.cloud.microsoft/chat?auth=2"
