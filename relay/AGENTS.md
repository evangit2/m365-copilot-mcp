# AGENTS.md

## Project

g365-headless-relay — Node.js off-screen Chromium bridge that wraps the M365 Copilot WebSocket (`substrate.office.com`) as a local `ws://127.0.0.1:8765` relay. No access tokens are extracted or cached — the browser's authenticated session handles all auth.

## Quick Start

```bash
# 1. Install deps
npm install

# 2. Configure credentials (copy and edit)
cp .env.example .env
# edit .env with your M365 email/password

# 3. Start relay (headless + VNC fallback + UI)
./start.sh

# 4. Open chat UI
# http://localhost:8767
```

If Microsoft requires MFA/CAPTCHA, `start.sh` will print a VNC URL for manual sign-in.

## Authentication Lifecycle

The relay relies on a persistent Chromium profile (`./profile/`) that stores cookies and session state. The browser runs off-screen via Xvfb but uses a **real headed browser** because true headless mode breaks M365 OAuth flows.

| State | Indicator | Action |
|-------|-----------|--------|
| **Authenticated** | Bridge reports `__m365Ready === true` | Relay works normally |
| **Session Expired** | Bridge times out, page loads login.microsoftonline.com | Re-auth required |
| **Profile Corrupt** | SingletonLock errors, Chrome crash on launch | Kill + clear locks, relaunch |

### First-time / Re-Auth

1. Put credentials in `.env` (gitignored).
2. Run `node tools/auto-signin.js` (or let `./start.sh` call it automatically).
3. If Microsoft blocks automation with MFA/CAPTCHA:
   ```bash
   ./tools/open-signin.sh
   # open the printed VNC URL and sign in manually
   ```
4. Verify:
   ```bash
   node tools/auth-check.js
   ```

## Commands

```
# Install
npm install                    # installs deps + downloads Chromium
node --check lib/*.js index.js # syntax-only check (no runtime)

# Run
./start.sh                     # full startup with auto-signin
node index.js --headless       # off-screen relay
node index.js --no-headless    # visible relay (debugging)
node index.js --port 9000      # custom port
node index.js --interval 30    # refresh every 30 min

# Tools
node tools/auto-signin.js      # headless sign-in from .env
node tools/auth-check.js       # check auth health
./tools/open-signin.sh         # manual sign-in on VNC
./tools/screenshot-vnc.sh      # capture VNC display
node test-e2e.js               # quick end-to-end test

# Batch files
start.cmd                      # off-screen relay
debug.cmd                      # visible browser relay
```

## Architecture

```
Client WS          Relay Server        Browser Page        Substrate WS
─────────          ────────────        ────────────        ────────────
ws://localhost     lib/server.js       lib/bridge.js       substrate.office.com
─────→              ─────→              ─────→              ─────→
  {type:"chat"}      page.evaluate       __m365Send()        buildChatInvoke()
                    (bridge call)       (injected JS)       (SignalR type:4)
                   ←─────              ←─────              ←─────
  {type:"delta"}     poll loop           __m365Poll()        type:1 update
                     setInterval 25ms
```

### Files

| File | Role |
|------|------|
| `index.js` | CLI parsing, browser launch, server orchestration |
| `lib/browser.js` | Launches Playwright Chromium with persistent profile |
| `lib/bridge.js` | Injected page script; intercepts substrate WebSocket |
| `lib/server.js` | External WebSocket server; one page per client connection |
| `lib/ui-server.js` | Express server serving the chat UI |
| `chat-ui/index.html` | Dark-theme chat interface |
| `tools/auto-signin.js` | Headless M365 sign-in helper |
| `tools/auth-check.js` | Standalone auth health check |
| `tools/open-signin.sh` | Visible Chrome on VNC for manual sign-in |
| `start.sh` | Full startup: Xvfb + VNC + noVNC + relay + auto-signin |

### Protocol (substrate.office.com SignalR — handled by `bridge.js`)

- Separator: `\x1e`
- Handshake: `{"protocol":"json","version":1}\x1e`
- Chat invoke: `{"type":4,"target":"chat","invocationId":"0","arguments":[...]}\x1e`
- Response types:
  - `type:1 target:update` → `writeAtCursor` streaming delta
  - `type:2` → `item.messages[]` full conversation
  - `type:3` → completion
  - `type:6` → ping (ignored)
- The `tone` parameter controls the model behavior:
  - `"Gpt_5_5_Reasoning"` — GPT 5.5 Think Deeper
  - `"Gpt_5_5_Chat"` — GPT 5.5 quick chat

## Client Protocol

Connect to `ws://127.0.0.1:8765`:

```
→ {"type":"new","model":"gpt-5.5-think-deeper"}
← {"type":"ready","model":"gpt-5.5-think-deeper"}

→ {"type":"chat","text":"Hello"}
← {"type":"delta","text":"Hel"}
← {"type":"delta","text":"lo"}
← {"type":"done"}
```

### Server → Client message types

| Type | Description |
|------|-------------|
| `ready` | Session created with model |
| `delta` | Streaming text token |
| `message` | Full bot response |
| `done` | Turn complete |
| `sent` | Message acknowledged by bridge |
| `error` | Error details |
| `pong` | Ping response |
| `auth_expired` | M365 session expired |

## Security / Git Notes

- `.env` and `profile/` are **gitignored**. Never commit them.
- The bridge does not extract access tokens.
- Keep credentials in `.env` only; use `.env.example` as a template.
- If publishing, double-check no secrets are in `README.md`, `AGENTS.md`, scripts, or logs.

## Common Issues

**"Looks like you launched a headed browser without having a XServer running"**  
→ Start Xvfb first, or run `./start.sh` which starts it for you.

**"Page failed to warm" / auth expired**  
→ Run `node tools/auth-check.js` and, if needed, `node tools/auto-signin.js`.

**Singleton lock errors**  
→ `rm profile/SingletonLock profile/SingletonCookie profile/SingletonSocket*`

**Client sends `new` but never gets `ready`**  
→ The server message handler now attaches immediately and queues early messages; if this still happens, the pool page may not be warming. Check `/tmp/relay.log`.
