# Hermes Agent memory prompt for m365-copilot-mcp

Save this as a memory fact so future Hermes sessions automatically know when and how to use the M365 Copilot MCP server.

## When to call it

The user has an MCP server named **m365-copilot** that exposes Microsoft 365 Copilot / **GPT 5.5 Think Deeper**.

Call `m365_copilot_chat` when the user asks for help with a genuinely hard coding problem:
- complex architecture or system design
- tricky debugging with subtle root causes
- security review or vulnerability analysis
- performance optimization
- non-trivial code generation from scratch
- reasoning through ambiguous requirements

Call `m365_copilot_suggest_edit` when the user wants an exact edit to a specific file. Pass the full current content (or a complete, well-delimited excerpt) and a clear instruction.

Do **not** use these tools for trivial tasks that the local model can handle directly.

## How to call it

Include all relevant context in the prompt:
- file paths
- error messages and stack traces
- current code snippets
- desired behavior
- constraints (framework, style, backwards compatibility)

For `m365_copilot_suggest_edit`, the response will contain the full new file content inside a code block. Apply it with the normal `write_file` or `patch` tool.

## Important notes

- The server may be rate-limited by Microsoft. If it reports a rate limit, wait and try again rather than hammering it.
- Each call starts a fresh M365 Copilot conversation by default (`m365_copilot_reset` is rarely needed).
- The underlying relay is at `http://127.0.0.1:9000` by default; if it is not ready, call `m365_copilot_status` first.
