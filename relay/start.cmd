@echo off
cd /d "%~dp0"
echo ============================================
echo   M365 Copilot Relay
echo ============================================
echo.
echo   Relay: ws://127.0.0.1:8765
echo   Models: GPT 5.5 Think Deeper ^| GPT 5.5 Quick Response
echo.
echo   Browser runs off-screen.
echo   Pages open only when a client connects.
echo.
node index.js --headless
pause
