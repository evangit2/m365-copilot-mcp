# g365-headless-relay

Node.js off-screen Chromium bridge for Microsoft 365 Copilot chat. No access tokens are extracted or cached — the browser session is the auth.

## How it works

1. Chromium launches with persistent profile (`./profile/`) — headed always, off-screen for hidden mode
2. When a WebSocket client connects, a page opens at `m365.cloud.microsoft/chat` and a bridge script is injected
3. The bridge intercepts the page's substrate WebSocket URL template
4. Client messages trigger the bridge to open its own substrate WS from within the page
5. Responses stream back to the client via a 200ms poll loop

## Quick start

```
npm install
debug.cmd       # first time — sign in (visible browser)
start.cmd       # off-screen relay
```

## WebSocket API

```
ws://127.0.0.1:8765

→ {"type":"new","model":"gpt-5.5-think-deeper"}
→ {"type":"chat","text":"hello"}
← {"type":"delta","text":"streaming..."}
← {"type":"message","text":"full response...","conversationId":"..."}
← {"type":"done"}
```

## Models

- `gpt-5.5-think-deeper` → tone `Gpt_5_5_Reasoning` (deeper reasoning)
- `gpt-5.5-quick` → tone `Gpt_5_5_Chat` (fast, concise)

## Architecture

| File | Role |
|------|------|
| `index.js` | CLI, browser launch, server orchestration |
| `lib/browser.js` | Chromium launcher (headed, off-screen mode) |
| `lib/bridge.js` | Injected page script — substrate WS relay |
| `lib/server.js` | WS server — per-client page, 200ms poll for deltas |
| `start.cmd` | Off-screen relay |
| `debug.cmd` | Visible browser for login |

## Substrate Protocol

Bridge sends SignalR messages to `substrate.office.com` with `\x1e` separator:
- Handshake → type:4 chat invoke (tone, optionsSets, message text, clientInfo)
- Responses: type:1 deltas → type:2 full message → type:3 done

## Key Behaviors

- Browser always headed (off-screen at x=-32000,y=-32000 for hidden mode)
- One page per client WebSocket connection
- No token extraction — browser session handles all auth
- Anti-detection: `--disable-blink-features=AutomationControlled`, real Chrome user-agent
