#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
G365_REPO="${G365_RELAY_REPO:-$HOME/projects/g365-headless-relay}"

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║  M365 Copilot MCP Server — Installer                     ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# 1. Install Node dependencies
if [[ ! -d "$REPO_DIR/node_modules" ]]; then
  echo "[install] Installing npm dependencies..."
  cd "$REPO_DIR" && npm install
else
  echo "[install] node_modules already present"
fi

# 2. Fetch g365-headless-relay if missing
if [[ ! -d "$G365_REPO" ]]; then
  echo "[install] Cloning g365-headless-relay into $G365_REPO ..."
  mkdir -p "$(dirname "$G365_REPO")"
  git clone https://github.com/evangit2/g365-headless-relay.git "$G365_REPO"
  cd "$G365_REPO" && npm install
else
  echo "[install] Found g365-headless-relay at $G365_REPO"
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

# 4. Ensure logs dir
mkdir -p "$REPO_DIR/logs"

echo ""
echo "Install complete."
echo ""
echo "Next steps:"
echo "  1. Edit $REPO_DIR/.env"
echo "  2. Run: $REPO_DIR/start.sh"
echo "  3. Add to Hermes Agent:"
echo "     hermes mcp add m365-copilot --command \"$REPO_DIR/mcp-server.js\""
echo ""
