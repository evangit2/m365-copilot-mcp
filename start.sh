#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
G365_REPO="${G365_RELAY_REPO:-$HOME/projects/g365-headless-relay}"
RELAY_URL="${RELAY_URL:-http://127.0.0.1:9000}"
PORT="${OPENAI_API_PORT:-9000}"
HOST="${OPENAI_API_HOST:-0.0.0.0}"
AUTH_MODE="${AUTH_MODE:-existing}"

# Load .env
if [[ -f "$REPO_DIR/.env" ]]; then
  set -a
  source "$REPO_DIR/.env"
  set +a
fi

# Prefer credentials if both email + password are present
if [[ -n "${M365_EMAIL:-}" && -n "${M365_PASSWORD:-}" ]]; then
  AUTH_MODE="credentials"
fi

export RELAY_URL PORT HOST AUTH_MODE G365_RELAY_REPO

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║  M365 Copilot MCP Server — Startup                     ║"
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
  if curl -s "$RELAY_URL/health" > /dev/null 2>&1; then
    RELAY_READY=true
  fi
fi

# Start relay if not already running
if [[ "$RELAY_READY" == "false" ]]; then
  echo "[start] Starting g365-headless-relay (auth mode: $AUTH_MODE)..."
  cd "$G365_REPO"
  OPENAI_API_PORT="$PORT" OPENAI_API_HOST="$HOST" REQUEST_LOG="$G365_REPO/logs/requests.ndjson" MAX_CONCURRENCY="${MAX_CONCURRENCY:-10}" ./start.sh > "$REPO_DIR/logs/relay.log" 2>&1 &
  echo $! > "$REPO_DIR/logs/relay.pid"
  echo "[start] Relay started (PID $(cat "$REPO_DIR/logs/relay.pid"))"
else
  echo "[start] Relay already running at $RELAY_URL"
fi

# Wait for relay health
echo "[start] Waiting for relay at $RELAY_URL ..."
for i in $(seq 1 60); do
  if curl -s "$RELAY_URL/health" > /dev/null 2>&1; then
    echo "[start] Relay ready"
    break
  fi
  sleep 2
done

if ! curl -s "$RELAY_URL/health" > /dev/null 2>&1; then
  echo "[start] ERROR: relay did not become ready. Check $REPO_DIR/logs/relay.log"
  exit 1
fi

echo ""
echo "MCP server starting. Connect Hermes Agent with:"
echo "  hermes mcp add m365-copilot --command \"$REPO_DIR/mcp-server.js\""
echo ""

# Run MCP server in foreground
cd "$REPO_DIR"
exec node mcp-server.js
