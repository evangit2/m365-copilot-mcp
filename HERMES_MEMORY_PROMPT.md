# Hermes Agent memory prompt for m365-copilot-mcp

Save this as a memory fact so future Hermes sessions automatically know when and how to use the M365 Copilot MCP server.

## When to call it

The user has an MCP server named **m365-copilot** that exposes Microsoft 365 Copilot / **GPT 5.5 Think Deeper**.

Use it as a **strong-model oracle** while the local cheap model runs the agent loop. Offload work to Copilot when any of these are true:

- The expected output is **more than ~100 lines of code** (file, module, or substantial refactor).
- The task requires **architecture or system design** across multiple interacting parts.
- The task involves **subtle debugging, security review, performance optimization, or complex reasoning**.
- The user explicitly says something like "use Copilot", "let GPT 5.5 think about this", or "this is hard".

**Default workflow for writing a large file (e.g. 300 lines):**
1. Gather context locally (read related files, understand conventions).
2. Call `m365_copilot_suggest_edit` with `file_path`, the current/existing file content (or a placeholder if the file is new), and a detailed instruction.
3. Apply the returned code block with `write_file` or `patch`.
4. Verify locally with `node --check`, tests, or a quick run.

For smaller edits (~20-50 lines), just use the local `patch` or `write_file` directly unless the user asks for Copilot.

For open-ended analysis, planning, or review, use `m365_copilot_chat`.

Do **not** use these tools for trivial one-liners that the local model can handle directly.

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
