#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
G365_REPO="${G365_RELAY_REPO:-$REPO_DIR/relay}"

# Keep legacy sibling install path discoverable if it already exists.
if [[ -z "${G365_RELAY_REPO:-}" && -d "$HOME/projects/g365-headless-relay" ]]; then
  G365_REPO="$HOME/projects/g365-headless-relay"
fi

PLUGIN_SRC="$REPO_DIR/hermes-plugin"
PLUGIN_DST="$HOME/.hermes/hermes-agent/plugins/m365_copilot_native"

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║  M365 Copilot MCP Server — Installer                       ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# 1. Install Node dependencies for the wrapper
if [[ ! -d "$REPO_DIR/node_modules" ]]; then
  echo "[install] Installing npm dependencies..."
  cd "$REPO_DIR" && npm install
else
  echo "[install] node_modules already present"
fi

# 2. Ensure g365-headless-relay dependencies are installed (relay is bundled
# inside this repo under relay/).
if [[ ! -d "$G365_REPO" ]]; then
  echo "[install] ERROR: relay not found at $G365_REPO"
  echo "[install] This project expects the relay at $REPO_DIR/relay"
  exit 1
fi
if [[ ! -d "$G365_REPO/node_modules" ]]; then
  echo "[install] Installing relay dependencies in $G365_REPO ..."
  cd "$G365_REPO" && npm install
else
  echo "[install] Found relay dependencies at $G365_REPO"
fi

# 3. Create .env if missing
if [[ ! -f "$REPO_DIR/.env" ]]; then
  echo "[install] Creating $REPO_DIR/.env from template..."
  cp "$REPO_DIR/.env.example" "$REPO_DIR/.env"
  echo ""
  echo "────────────────────────────────────────────────────────────"
  echo "  ACTION REQUIRED: edit $REPO_DIR/.env"
  echo "  • Add your M365 email + password for automatic sign-in, OR"
  echo "  • Leave credentials blank and use VNC manual sign-in"
  echo "────────────────────────────────────────────────────────────"
fi

# 4. Symlink the Hermes native plugin so Hermes auto-loads it
if [[ -L "$PLUGIN_DST" ]]; then
  current_target="$(readlink "$PLUGIN_DST" 2>/dev/null || true)"
  if [[ "$current_target" != "$PLUGIN_SRC" ]]; then
    echo "[install] Replacing existing Hermes plugin symlink..."
    rm "$PLUGIN_DST"
    ln -s "$PLUGIN_SRC" "$PLUGIN_DST"
  else
    echo "[install] Hermes plugin symlink already correct"
  fi
elif [[ -e "$PLUGIN_DST" ]]; then
  echo "[install] WARNING: $PLUGIN_DST exists and is not a symlink; leaving it alone"
else
  echo "[install] Linking Hermes native plugin..."
  mkdir -p "$(dirname "$PLUGIN_DST")"
  ln -s "$PLUGIN_SRC" "$PLUGIN_DST"
fi

# 5. Ensure logs dir
mkdir -p "$REPO_DIR/logs"

echo ""
echo "Install complete."
echo ""
echo "Next steps:"
echo "  1. Edit $REPO_DIR/.env (only needed once)"
echo "  2. Run: $REPO_DIR/start.sh"
echo ""
echo "The native Hermes toolset 'm365_copilot_native' will be auto-loaded."
echo "To uninstall later, run: $REPO_DIR/uninstall.sh"
echo ""

# 6. Optionally auto-start the native HTTP tools server in the background
if [[ "${INSTALL_START_TOOLS_SERVER:-}" == "true" ]]; then
  if ! curl -fsS "http://${MCP_TOOLS_HOST:-127.0.0.1}:${MCP_TOOLS_PORT:-9100}/health" > /dev/null 2>&1; then
    echo "[install] Starting native HTTP tools server in background..."
    cd "$REPO_DIR"
    nohup node tools-server.js > "$REPO_DIR/logs/tools-server.log" 2>&1 &
    echo $! > "$REPO_DIR/logs/tools-server.pid"
  else
    echo "[install] Native HTTP tools server already running"
  fi
fi
