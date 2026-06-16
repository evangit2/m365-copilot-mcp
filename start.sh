#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load .env before deriving defaults so values in the file actually take effect.
if [[ -f "$REPO_DIR/.env" ]]; then
  chmod go-rwx "$REPO_DIR/.env" 2>/dev/null || true
  set -a
  # shellcheck disable=SC1091
  source "$REPO_DIR/.env"
  set +a
fi

RELAY_URL="${RELAY_URL:-http://127.0.0.1:9000}"
OPENAI_API_PORT="${OPENAI_API_PORT:-9000}"
OPENAI_API_HOST="${OPENAI_API_HOST:-0.0.0.0}"
AUTH_MODE="${AUTH_MODE:-existing}"
G365_REPO="${G365_RELAY_REPO:-$REPO_DIR/vendor/g365-headless-relay}"

# Keep legacy sibling install path discoverable if it already exists.
if [[ -z "${G365_RELAY_REPO:-}" && -d "$HOME/projects/g365-headless-relay" ]]; then
  G365_REPO="$HOME/projects/g365-headless-relay"
fi

G365_RELAY_REPO="$G365_REPO"
MAX_CONCURRENCY="${MAX_CONCURRENCY:-10}"

# Prefer credentials if both email + password are present. If credentials mode
# was selected with blank credentials, fall back to VNC instead of failing later.
if [[ -n "${M365_EMAIL:-}" && -n "${M365_PASSWORD:-}" ]]; then
  AUTH_MODE="credentials"
elif [[ "$AUTH_MODE" == "credentials" ]]; then
  echo "[start] AUTH_MODE=credentials but M365_EMAIL/M365_PASSWORD are blank; using AUTH_MODE=vnc"
  AUTH_MODE="vnc"
fi

export RELAY_URL AUTH_MODE G365_RELAY_REPO OPENAI_API_PORT OPENAI_API_HOST MAX_CONCURRENCY

STARTED_RELAY=false
cleanup() {
  if [[ "$STARTED_RELAY" == "true" && -f "$REPO_DIR/logs/relay.pid" ]]; then
    local pid
    pid="$(cat "$REPO_DIR/logs/relay.pid" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "[start] Stopping relay PID $pid"
      kill "$pid" 2>/dev/null || true
    fi
  fi
}
trap cleanup EXIT INT TERM

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║  M365 Copilot MCP Server — Startup                       ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Ensure g365-headless-relay exists
if [[ ! -d "$G365_REPO" ]]; then
  echo "[start] g365-headless-relay not found at $G365_REPO"
  echo "[start] Run ./install.sh first or set G365_RELAY_REPO"
  exit 1
fi

# Start Xvfb if needed (headless sign-in)
if [[ "$AUTH_MODE" == "credentials" && -z "${DISPLAY:-}" ]]; then
  if ! pgrep -x Xvfb > /dev/null 2>&1; then
    echo "[start] Starting Xvfb on :99..."
    Xvfb :99 -screen 0 1280x720x24 > /tmp/xvfb-mcp.log 2>&1 &
    sleep 2
  fi
  export DISPLAY=:99
fi

# Check if relay is already healthy
RELAY_READY=false
if command -v curl > /dev/null 2>&1; then
  if curl -fsS "$RELAY_URL/health" > /dev/null 2>&1; then
    RELAY_READY=true
  fi
fi

# Start relay if not already running
mkdir -p "$REPO_DIR/logs" "$G365_REPO/logs"
if [[ "$RELAY_READY" == "false" ]]; then
  echo "[start] Starting g365-headless-relay (auth mode: $AUTH_MODE)..."
  cd "$G365_REPO"
  REQUEST_LOG="$G365_REPO/logs/requests.ndjson" ./start.sh > "$REPO_DIR/logs/relay.log" 2>&1 &
  echo $! > "$REPO_DIR/logs/relay.pid"
  STARTED_RELAY=true
  echo "[start] Relay started (PID $(cat "$REPO_DIR/logs/relay.pid"))"
else
  echo "[start] Relay already running at $RELAY_URL"
fi

# Wait for relay health
echo "[start] Waiting for relay at $RELAY_URL ..."
for _ in $(seq 1 60); do
  if curl -fsS "$RELAY_URL/health" > /dev/null 2>&1; then
    echo "[start] Relay ready"
    break
  fi
  sleep 2
done

if ! curl -fsS "$RELAY_URL/health" > /dev/null 2>&1; then
  echo "[start] ERROR: relay did not become ready. Check $REPO_DIR/logs/relay.log"
  exit 1
fi

echo ""
echo "MCP server starting. Connect Hermes Agent with:"
echo "  hermes mcp add m365-copilot --command \"$REPO_DIR/mcp-server.js\""
echo ""

# Run MCP server in foreground so cleanup traps run when it exits.
cd "$REPO_DIR"
node mcp-server.js
