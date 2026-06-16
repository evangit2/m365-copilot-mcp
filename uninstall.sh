#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
G365_REPO="${G365_RELAY_REPO:-$REPO_DIR/relay}"
PLUGIN_DST="$HOME/.hermes/hermes-agent/plugins/m365_copilot_native"

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║  M365 Copilot MCP Server — Uninstaller                     ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# 1. Stop the native HTTP tools server if we started it
if [[ -f "$REPO_DIR/logs/tools-server.pid" ]]; then
  pid="$(cat "$REPO_DIR/logs/tools-server.pid" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "[uninstall] Stopping native HTTP tools server (PID $pid)..."
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$REPO_DIR/logs/tools-server.pid"
fi

# 2. Stop the relay if we started it
if [[ -f "$REPO_DIR/logs/relay.pid" ]]; then
  pid="$(cat "$REPO_DIR/logs/relay.pid" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "[uninstall] Stopping relay (PID $pid)..."
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$REPO_DIR/logs/relay.pid"
fi

# Also try to stop any relay started from the sibling install location
for pidfile in "$G365_REPO/logs/relay.pid" "$HOME/projects/g365-headless-relay/logs/relay.pid"; do
  if [[ -f "$pidfile" ]]; then
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "[uninstall] Stopping relay at $pidfile (PID $pid)..."
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  fi
done

# 3. Remove the Hermes native plugin symlink
if [[ -L "$PLUGIN_DST" ]]; then
  echo "[uninstall] Removing Hermes plugin symlink..."
  rm "$PLUGIN_DST"
elif [[ -e "$PLUGIN_DST" ]]; then
  echo "[uninstall] WARNING: $PLUGIN_DST is not a symlink; leaving it alone"
fi

# 4. Optionally disable the legacy MCP server in Hermes config if still enabled
if command -v hermes >/dev/null 2>&1; then
  if hermes config get mcp_servers.m365-copilot.enabled 2>/dev/null | grep -q "true"; then
    echo "[uninstall] Disabling legacy MCP server in Hermes config..."
    hermes config set mcp_servers.m365-copilot.enabled false 2>/dev/null || true
  fi
fi

echo ""
echo "Uninstall complete."
echo ""
echo "The following were NOT deleted (delete manually if desired):"
echo "  • $REPO_DIR (source code, logs, .env)"
echo "  • $G365_REPO (relay source and profile)"
echo "  • ~/.hermes/config.yaml (Hermes config)"
echo ""
echo "To fully remove everything, run:"
echo "  rm -rf $REPO_DIR $G365_REPO"
echo ""
