#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DISPLAY=:99
cd "$SCRIPT_DIR"
exec node open-visible-browser.js > /tmp/visible-browser.log 2>&1