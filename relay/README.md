# g365-headless-relay

Node.js off-screen Chromium bridge that wraps the M365 Copilot WebSocket (`substrate.office.com`) as a local `ws://127.0.0.1:8765` relay.

No access tokens are extracted or cached — the browser's authenticated session handles all auth.

## Quick start

```bash
npm install

# Copy example env and fill in your M365 credentials
cp .env.example .env
# edit .env

./start.sh
```

Then open **http://localhost:8767** for the chat UI.

## Authentication

The relay needs a persistent Chromium profile with an authenticated M365 session.

1. Create `.env` from `.env.example` with your M365 email and password.
2. Run `./start.sh`.
3. On first run it will sign in headlessly via `tools/auto-signin.js`.
4. If Microsoft requires MFA/CAPTCHA, open the printed VNC URL and sign in manually.

Profile data is stored in `./profile/` (gitignored). Cookies and session state stay inside the browser.

## Commands

| Command | Description |
|---------|-------------|
| `./start.sh` | Start Xvfb + relay + VNC + chat UI; auto-signs in if needed |
| `node tools/auto-signin.js` | Headless sign-in using `.env` |
| `node tools/auth-check.js` | Check if profile is authenticated |
| `./tools/open-signin.sh` | Open visible Chrome on VNC for manual sign-in |
| `node test-e2e.js` | Quick end-to-end test |

## Relay protocol

Connect to `ws://127.0.0.1:8765`:

```
→ { "type": "new", "model": "gpt-5.5-think-deeper" }
← { "type": "ready", "model": "gpt-5.5-think-deeper" }

→ { "type": "chat", "text": "Hello" }
← { "type": "delta", "text": "Hel" }
← { "type": "delta", "text": "lo" }
← { "type": "done" }
```

## Project layout

- `index.js` — CLI entrypoint
- `lib/browser.js` — Playwright Chromium launcher
- `lib/bridge.js` — Injected page script that talks to M365 substrate
- `lib/server.js` — WebSocket relay server
- `lib/ui-server.js` — Chat UI Express server
- `tools/auto-signin.js` — Headless M365 sign-in helper
- `tools/auth-check.js` — Auth health check
- `tools/open-signin.sh` — Manual sign-in helper
- `chat-ui/index.html` — Dark-themed web chat UI

## Security notes

- `.env` and `profile/` are gitignored. Never commit them.
- The bridge does not extract access tokens; it uses the browser's own cookies.
- For headless sign-in, your credentials are only read from `.env` at runtime.
