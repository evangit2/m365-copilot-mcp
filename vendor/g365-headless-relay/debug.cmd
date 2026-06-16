@echo off
cd /d "%~dp0"
echo ============================================
echo   M365 Copilot Relay - DEBUG MODE
echo ============================================
echo.
echo   Relay: ws://127.0.0.1:8765
echo   Models: GPT 5.5 Think Deeper ^| GPT 5.5 Quick Response
echo.
echo   Browser window visible for interactive sign-in.
echo   M365 page opens when a WebSocket client connects.
echo.
node index.js --no-headless
pause
