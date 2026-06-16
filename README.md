# M365 Copilot MCP Server for Hermes Agent

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that exposes Microsoft 365 Copilot / **GPT 5.5 Think Deeper** as a tool for autonomous agents — especially [Hermes Agent](https://hermes-agent.nousresearch.com/).

Use it when your agent hits a genuinely hard coding problem: complex architecture, tricky debugging, security review, performance optimization, or writing non-trivial code from scratch. The bundled `relay/` directory keeps an M365 session alive and provides both an OpenAI-compatible HTTP endpoint and a faster direct WebSocket path.

> **Credits:** the underlying headless M365 Copilot relay started as [`notBlubbll/g365-headless-relay`](https://github.com/notBlubbll/g365-headless-relay). This project now bundles that relay, a fast native Hermes toolset, and an MCP server in one repo.

---

## Two ways to use it with Hermes

1. **Native Hermes toolset (recommended, faster)** — `hermes-plugin/` is registered as a Hermes backend toolset. It calls a long-lived local `tools-server.js` over HTTP, which in turn uses the fast WebSocket relay path. No stdio spawn per turn.
2. **MCP stdio server (legacy)** — `mcp-server.js` speaks the Model Context Protocol over stdio. Slower because it spawns a process per turn and adds JSON-RPC overhead.

For low-capacity Hermes models, the native toolset is strongly preferred.

---

## Drop-in agent prompt / system memory

Paste this into the agent's system prompt or Hermes user memory. It forces weak models to delegate all non-trivial work to the M365 tools instead of trying to code themselves.

```
You have access to Microsoft 365 Copilot / GPT 5.5 Think Deeper through the
`m365_copilot_native` toolset (or the `m365-copilot` MCP server if native tools
are not available).

Delegation rule: if you are a small, fast, or low-capacity model, you MUST use
these tools for any non-trivial work. Do NOT write code, produce patches,
perform architecture design, debug complex errors, do security review, or
write multi-step plans yourself.

Always delegate to:
  - m365_copilot_chat         for hard coding questions, debugging, architecture
  - m365_copilot_suggest_edit   when the user wants an exact change to a file
  - m365_copilot_status         to verify Copilot is ready before a long operation

Include full context in every call: file paths, current code, exact error
messages, stack traces, and the desired outcome. Pass include_reasoning=true
when you need to show the model's chain of thought.
```

Save it to Hermes memory with:

```bash
hermes memory add "Low-capacity Hermes models must delegate all non-trivial coding work to the m365_copilot_native toolset (m365_copilot_chat / m365_copilot_suggest_edit). Do not write code yourself."
```

---

## Quick start

```bash
# 1. Clone this repo
git clone https://github.com/evangit2/m365-copilot-mcp.git ~/projects/m365-copilot-mcp
cd ~/projects/m365-copilot-mcp

# 2. Install dependencies for both the wrapper and the bundled relay
./install.sh

# 3. Configure credentials or VNC sign-in
nano .env

# 4. Start the relay (credentials mode needs M365_EMAIL / M365_PASSWORD)
./start.sh

# 5. Start the native Hermes HTTP tools server (kept alive in background)
node tools-server.js &
```

The native Hermes plugin is auto-loaded from `~/.hermes/hermes-agent/plugins/m365_copilot_native`, which is symlinked to `hermes-plugin/` in this repo. If the symlink is missing, create it:

```bash
ln -s ~/projects/m365-copilot-mcp/hermes-plugin \
  ~/.hermes/hermes-agent/plugins/m365_copilot_native
```

---

## Performance

| Path | Typical total time | TTFT | Notes |
|------|------------------|------|-------|
| MCP stdio → HTTP OpenAI | ~7.6 s | ~7.6 s | Spawns process, HTTP wrapper |
| Native tool → WebSocket | ~5.4 s | ~2.9–3.2 s | Long-lived server, fast WS |

Set `MCP_USE_FAST_WS=true` and `RELAY_WS_URL=ws://127.0.0.1:8765` to enable the fast path. It is on by default in `.env.example`.

---

## Sign-in modes

| Mode | How it works | Best for |
|------|--------------|----------|
| `credentials` | Headless Chromium signs in with `M365_EMAIL` + `M365_PASSWORD` | Fully automated agents |
| `vnc` | Opens a browser via VNC; you sign in once | Accounts with MFA |
| `existing` | Assumes the relay is already running | You already set it up |

Set `AUTH_MODE` in `.env`. If both `M365_EMAIL` and `M365_PASSWORD` are present, `start.sh` automatically picks `credentials` mode.

---

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `M365_EMAIL` | — | Microsoft account email |
| `M365_PASSWORD` | — | Microsoft account password |
| `AUTH_MODE` | `credentials` | `credentials` \| `vnc` \| `existing` |
| `G365_RELAY_REPO` | `~/projects/m365-copilot-mcp/relay` | Path to bundled relay |
| `RELAY_URL` | `http://127.0.0.1:9000` | Relay OpenAI HTTP API |
| `RELAY_WS_URL` | `ws://127.0.0.1:8765` | Relay direct WebSocket (fast path) |
| `RELAY_API_KEY` | — | Optional bearer key if relay requires auth |
| `M365_MODEL` | `gpt-5.5-think-deeper` | Default Copilot tone |
| `MCP_TOOLS_PORT` | `9100` | Native Hermes HTTP tools server port |
| `MCP_TOOLS_HOST` | `127.0.0.1` | Native Hermes HTTP tools server host |
| `MCP_USE_FAST_WS` | `true` | Use WebSocket instead of HTTP for chat |
| `MAX_CONCURRENCY` | `10` | Upstream request ceiling |
| `OPENAI_API_PORT` | `9000` | Relay HTTP port |
| `OPENAI_API_HOST` | `0.0.0.0` | Relay HTTP bind host |

See `.env.example` for a complete template.

---

## How it works

1. `install.sh` installs Node dependencies for the wrapper and the bundled `relay/`.
2. `start.sh` launches the relay in the chosen auth mode.
3. The relay captures the substrate WebSocket once, then uses a pure Node.js SignalR client for chat.
4. `tools-server.js` stays alive and exposes the tools over HTTP, using the fast WebSocket relay path.
5. The Hermes native plugin (`hermes-plugin/`) calls `tools-server.js` and registers the tools as a backend toolset.
6. The MCP stdio server (`mcp-server.js`) remains available for non-Hermes MCP clients.

---

## Example prompts for Hermes Agent

> "Use `m365_copilot_chat` to think through this architecture problem. I need a design for ..."

> "I'm stuck on a bug. Call `m365_copilot_chat` with the full stack trace and source context and ask for the most likely root cause."

> "Use `m365_copilot_suggest_edit` to refactor `src/db.ts` so it uses connection pooling instead of opening a new connection each request."

> "Check `m365_copilot_status` with deep_check=true before we start the big refactor."

---

## Saving the habit to Hermes memory

```bash
hermes memory add "Low-capacity Hermes models must delegate all non-trivial coding work to the m365_copilot_native toolset: m365_copilot_chat for hard coding/debugging/architecture, m365_copilot_suggest_edit for exact file edits. Do not write code yourself."
```

---

## Compatibility

- **Hermes Agent (recommended):** use the native `m365_copilot_native` toolset or the MCP server.
- **Other MCP clients:** `mcp-server.js` is a standard stdio MCP server that works with Claude Desktop, Cline, Continue, etc.

---

## License

MIT

---

## Roadmap / known gaps

1. **Pin relay dependency to a commit/tag** — add `RELAY_REF` to `.env.example`.
2. **Session / conversation isolation** — add optional `conversation_id` to keep context across calls.
3. **Streaming MCP support** — stdio MCP does not stream well; native toolset already avoids this.
4. **Browserless sign-in research** — investigate MSAL / device-code flows.
5. **Request audit and usage tracking** — log every call locally.
6. **Tool result caching** — cache identical prompts for a short TTL.
7. **Multi-account support** — switch between M365 profiles.
8. **HTTP/SSE MCP transport** — for remote MCP clients.

---

## Credits

- Original headless M365 Copilot relay: [`notBlubbll/g365-headless-relay`](https://github.com/notBlubbll/g365-headless-relay)
- Extended relay with headless sign-in, direct SignalR chat, and OpenAI-compatible API: [`evangit2/g365-headless-relay`](https://github.com/evangit2/g365-headless-relay)
- Bundled MCP + native Hermes toolset: this repo
