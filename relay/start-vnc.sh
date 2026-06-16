#!/bin/bash
set -e

# G365 Relay + VNC setup script

# Cleanup existing
pkill -f "x11vnc" 2>/dev/null || true
pkill -f "websockify" 2>/dev/null || true
pkill -9 -f "Xvfb" 2>/dev/null || true
sleep 1

# Start Xvfb
Xvfb :99 -screen 0 1280x720x24 -ac +extension GLX +render -noreset > /tmp/xvfb.log 2>&1 &
XVFB_PID=$!
echo $XVFB_PID > /tmp/xvfb.pid
sleep 2

# Start x11vnc
x11vnc -display :99 -nopw -forever -shared -rfbport 5900 > /tmp/x11vnc.log 2>&1 &
VNC_PID=$!
echo $VNC_PID > /tmp/x11vnc.pid
sleep 2

# Start noVNC
websockify --web=/usr/share/novnc --cert=none 6080 localhost:5900 > /tmp/novnc.log 2>&1 &
NOVNC_PID=$!
echo $NOVNC_PID > /tmp/novnc.pid
sleep 2

echo "Services started:"
echo "  Xvfb PID: $XVFB_PID"
echo "  x11vnc PID: $VNC_PID"
echo "  websockify PID: $NOVNC_PID"
echo ""
echo "noVNC URL: http://$(hostname -I | awk '{print $1}'):6080/vnc.html"
echo ""
echo "Logs:"
cat /tmp/x11vnc.log | tail -5
echo "---"
cat /tmp/novnc.log | tail -5
