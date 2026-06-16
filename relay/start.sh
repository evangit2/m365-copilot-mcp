#!/bin/bash
# G365 Copilot Relay - Start script
# Starts Xvfb + relay + x11vnc + noVNC
# If .env has M365_EMAIL/M365_PASSWORD and auth is missing, auto-signs in first.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE_DIR="$SCRIPT_DIR/profile"
LOG_DIR="/tmp"
RELAY_PORT=8765
UI_PORT=8767
OPENAI_API_PORT=9000
OPENAI_API_HOST=0.0.0.0
MAX_CONCURRENCY=10

export PROFILE_DIR
export OPENAI_API_PORT OPENAI_API_HOST MAX_CONCURRENCY

cd "$SCRIPT_DIR"

echo "=== G365 Copilot Relay ==="
echo "Profile: $PROFILE_DIR"
echo ""

# Kill any existing relay processes on our ports
echo "Cleaning up old processes..."
lsof -ti:"$RELAY_PORT" | xargs kill -9 2>/dev/null
lsof -ti:"$UI_PORT" | xargs kill -9 2>/dev/null
pkill -f "node.*index.js" 2>/dev/null
sleep 1

# Clear any singleton locks from previous crashes
rm -f "$PROFILE_DIR"/SingletonLock "$PROFILE_DIR"/SingletonCookie "$PROFILE_DIR"/SingletonSocket* 2>/dev/null

# Start Xvfb
if ! pgrep -x Xvfb >/dev/null; then
    echo "Starting Xvfb..."
    Xvfb :99 -screen 0 1280x720x24 -ac +extension GLX +render -noreset \
        > "$LOG_DIR/xvfb.log" 2>&1 &
    sleep 2
fi

# Start x11vnc (for remote viewing if needed)
if ! pgrep -x x11vnc >/dev/null; then
    echo "Starting x11vnc on :5900..."
    x11vnc -display :99 -nopw -forever -shared -listen 0.0.0.0 -rfbport 5900 \
        > "$LOG_DIR/x11vnc.log" 2>&1 &
fi

# Start noVNC
if ! pgrep -f websockify >/dev/null; then
    echo "Starting noVNC on :6080..."
    websockify --web=/usr/share/novnc --cert=none 6080 localhost:5900 \
        > "$LOG_DIR/novnc.log" 2>&1 &
fi

# Auto-sign-in if .env exists and auth check fails
if [[ -f "$SCRIPT_DIR/.env" ]]; then
    echo ""
    echo "Checking auth (auto-signin enabled via .env)..."
    # Quick check: launch a page and see if it hits login
    export DISPLAY=:99
    set +e
    node tools/auth-check.js --quiet >/dev/null 2>&1
    AUTH_OK=$?
    set -e
    if [[ $AUTH_OK -ne 0 ]]; then
        echo "Auth missing or expired — running auto-signin..."
        set +e
        node tools/auto-signin.js
        SIGNIN_OK=$?
        set -e
        if [[ $SIGNIN_OK -ne 0 ]]; then
            echo ""
            echo "❌ Auto-signin failed (exit $SIGNIN_OK)."
            echo "   VNC remote: http://$(hostname -I | awk '{print $1}'):6080/vnc.html"
            echo "   Manual fallback: ./tools/open-signin.sh"
            exit 1
        fi
        echo "✅ Auto-signin succeeded"
    else
        echo "✅ Auth healthy"
    fi
fi

# Start the relay
# Load optional secrets from .env
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

echo ""
echo "Starting relay (pool-size: 5, max-concurrency: ${MAX_CONCURRENCY:-10})..."
DISPLAY=:99 node index.js --headless --ui-port "$UI_PORT" --pool-size 1 \
    > "$LOG_DIR/relay.log" 2>> "$LOG_DIR/relay.log" &
disown
RELAY_PID=$!
echo "Relay PID: $RELAY_PID"

echo ""
echo "Relay WS:      ws://127.0.0.1:$RELAY_PORT"
echo "OpenAI API:    http://${OPENAI_API_HOST:-0.0.0.0}:$OPENAI_API_PORT/v1/chat/completions"
echo "Chat UI:       http://127.0.0.1:$UI_PORT"
echo "VNC remote:    http://$(hostname -I | awk '{print $1}'):6080/vnc.html"
echo ""

echo "Health: curl http://${OPENAI_API_HOST:-0.0.0.0}:$OPENAI_API_PORT/health"
echo "To stop: kill $RELAY_PID"
