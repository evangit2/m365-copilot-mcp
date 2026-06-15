# M365 Copilot MCP Server for Hermes Agent

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that exposes Microsoft 365 Copilot / **GPT 5.5 Think Deeper** as a tool for autonomous agents — especially [Hermes Agent](https://hermes-agent.nousresearch.com/).

Use it when your agent hits a genuinely hard coding problem: complex architecture, tricky debugging, security review, performance optimization, or writing non-trivial code from scratch. The server talks to a local [g365-headless-relay](https://github.com/evangit2/g365-headless-relay) instance which keeps an M365 session alive and provides an OpenAI-compatible HTTP endpoint.

> **Credits:** the underlying headless M365 Copilot relay started as [`notBlubbll/g365-headless-relay`](https://github.com/notBlubbll/g365-headless-relay). This MCP server is a new wrapper built on top of that work.

---

## What it gives Hermes Agent

- `m365_copilot_chat` — ask GPT 5.5 Think Deeper a hard coding question
- `m365_copilot_suggest_edit` — give it a file and instructions, get back an exact replacement
- `m365_copilot_status` — check whether the relay is signed in and ready
- `m365_copilot_history` — list recent Copilot conversations (experimental)
- `m365_copilot_reset` — start a fresh conversation

The server runs over **stdio** so Hermes can spawn it as an MCP tool provider.

---

## Quick start

```bash
# 1. Clone this repo
git clone https://github.com/evangit2/m365-copilot-mcp.git ~/m365-copilot-mcp
cd ~/m365-copilot-mcp

# 2. Run the installer (installs deps and clones g365-headless-relay if needed)
./install.sh

# 3. Edit .env with your M365 credentials, or leave them blank for VNC sign-in
nano .env

# 4. Start the relay + MCP server
./start.sh
```

In another terminal, add it to Hermes:

```bash
hermes mcp add m365-copilot --command "$HOME/m365-copilot-mcp/mcp-server.js"
```

Then start a Hermes session and use the tools.

---

## Sign-in modes

| Mode | How it works | Best for |
|------|--------------|----------|
| `credentials` | Headless Chromium signs in with `M365_EMAIL` + `M365_PASSWORD` | Fully automated agents |
| `vnc` | Opens a browser via VNC; you sign in once | Accounts with MFA |
| `existing` | Assumes `g365-headless-relay` is already running | You already set it up |

Set `AUTH_MODE` in `.env`. If both `M365_EMAIL` and `M365_PASSWORD` are present, `start.sh` automatically picks `credentials` mode.

---

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `M365_EMAIL` | — | Microsoft account email |
| `M365_PASSWORD` | — | Microsoft account password |
| `AUTH_MODE` | `credentials` | `credentials` \| `vnc` \| `existing` |
| `G365_RELAY_REPO` | `~/projects/g365-headless-relay` | Path to relay repo |
| `RELAY_URL` | `http://127.0.0.1:9000` | Relay OpenAI API URL |
| `RELAY_API_KEY` | — | Optional bearer key if relay requires auth |
| `M365_MODEL` | `gpt-5.5-think-deeper` | Default Copilot tone |
| `MAX_CONCURRENCY` | `10` | Upstream request ceiling |
| `OPENAI_API_PORT` | `9000` | Relay HTTP port |
| `OPENAI_API_HOST` | `0.0.0.0` | Relay HTTP bind host |

See `.env.example` for a complete template.

---

## How it works

1. `install.sh` installs Node dependencies and ensures `g365-headless-relay` is present.
2. `start.sh` (if needed) launches the relay:
   - In `credentials` mode it runs the relay's headless sign-in script against your M365 profile.
   - In `vnc` mode it starts the relay's browser and prints a VNC URL for manual sign-in.
   - In `existing` mode it just connects to the relay you already started.
3. The relay captures the substrate WebSocket URL once, then uses a pure Node.js SignalR client for all subsequent chat — no Chromium per request.
4. This MCP server translates tool calls into relay HTTP requests and returns the results to Hermes.

---

## Example prompts for Hermes Agent

After adding the MCP server, you can tell Hermes:

> "Use `m365_copilot_chat` to think through this architecture problem. I need a design for ..."

> "I'm stuck on a bug. Call `m365_copilot_chat` with the full stack trace and source context and ask for the most likely root cause."

> "Use `m365_copilot_suggest_edit` to refactor `src/db.ts` so it uses connection pooling instead of opening a new connection each request."

---

## Saving the habit to Hermes memory

Add this to your Hermes user memory so future sessions remember to call Copilot for hard coding work:

```
User has an MCP server named m365-copilot that exposes Microsoft 365 Copilot / GPT 5.5 Think Deeper.
When the user asks for help with a genuinely hard coding problem — complex architecture, tricky debugging,
security review, performance optimization, or non-trivial code generation — call the m365_copilot_chat
tool with full context (file paths, error messages, relevant code snippets). Use m365_copilot_suggest_edit
when the user wants an exact edit to a specific file. Do not use it for trivial tasks that the local model
can handle.
```

Save it with:

```bash
hermes memory add "m365-copilot usage: call m365_copilot_chat for hard coding problems, m365_copilot_suggest_edit for exact file edits"
```

Or place `HERMES_MEMORY_PROMPT.md` from this repo in your project root and load it with `/skill m365-copilot-hermes-memory` once Hermes indexes it.

---

## Compatibility

While designed for Hermes Agent, this is a standard MCP stdio server. It works with any MCP client (Claude Desktop, Cline, Continue, etc.) that can spawn a local command.

---

## License

MIT

---

## Roadmap / known gaps

These are concrete improvements we want to make to the MCP server program itself:

1. **Pin relay dependency to a commit/tag** — `install.sh` clones `evangit2/g365-headless-relay` without pinning. Add `RELAY_REF` to `.env.example` and verify the checkout.
2. **Harden `.env` credential handling** — enforce `0600` permissions, refuse to start if world-readable, redact secrets from logs/errors.
3. **Orphaned relay cleanup** — `start.sh` launches the relay in the background but if the MCP server exits, the relay stays running. Add PID tracking and cleanup in both `start.sh` and `mcp-server.js`.
4. **Session / conversation isolation** — every call currently starts a fresh Copilot conversation. Add an optional `conversation_id` parameter so Hermes can keep context across multiple calls for one task.
5. **Streaming support** — long code generation can hit `max_tokens`. Add a `stream` option or chunked polling so big outputs do not truncate.
6. **Browserless sign-in research** — investigate MSAL / device-code / other flows to eventually eliminate Chromium for authentication.
7. **Request audit and usage tracking** — log every MCP call locally (prompt length, model, duration) so users can see M365 usage.
8. **Better error classification** — map relay errors to actionable MCP messages: "auth expired → re-run sign-in", "rate limited → wait N seconds", "relay not ready → check VNC URL".
9. **Tool result caching** — cache identical prompts for a short TTL to avoid repeated Copilot calls for the same question.
10. **Multi-account support** — allow switching between multiple M365 profiles/accounts via env var or tool argument.
11. **Add tests** — unit tests for `RelayClient` and `AuthManager`, plus integration tests against the relay.
12. **HTTP / SSE MCP transport** — currently only stdio; add HTTP transport so remote agents can connect without spawning a local process.

---

## Credits

- Original headless M365 Copilot relay: [`notBlubbll/g365-headless-relay`](https://github.com/notBlubbll/g365-headless-relay)
- Extended relay with headless sign-in, direct SignalR chat, and OpenAI-compatible API: [`evangit2/g365-headless-relay`](https://github.com/evangit2/g365-headless-relay)
- MCP server wrapper: this repo
