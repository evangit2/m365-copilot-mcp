"""Native Hermes tools for Microsoft 365 Copilot.

This plugin registers the same tools as the stdio MCP server but calls a
long-lived local HTTP server (tools-server.js from m365-copilot-mcp). That
avoids spawning a new MCP subprocess on every turn and uses the fast
WebSocket relay path internally.

The plugin auto-starts tools-server.js on first tool call if it is not
already listening on MCP_TOOLS_HOST:MCP_TOOLS_PORT (default 127.0.0.1:9100).
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict

from tools.registry import tool_error, tool_result

logger = logging.getLogger(__name__)

TOOLS_HOST = os.environ.get("MCP_TOOLS_HOST", "127.0.0.1")
TOOLS_PORT = int(os.environ.get("MCP_TOOLS_PORT", "9100"))
TOOLS_BASE = f"http://{TOOLS_HOST}:{TOOLS_PORT}"
TOOLS_REPO = Path(os.environ.get("MCP_REPO", Path.home() / "projects" / "m365-copilot-mcp"))
TOOLS_SERVER_JS = TOOLS_REPO / "tools-server.js"

_M365_STATUS_SCHEMA = {
    "name": "m365_copilot_status",
    "description": "Check whether the M365 Copilot relay is healthy and ready. Set deep_check=true to verify the captured Copilot session with a tiny chat request.",
    "parameters": {
        "type": "object",
        "properties": {
            "deep_check": {
                "type": "boolean",
                "description": "If true, send a tiny chat completion to catch stale auth tokens that /health cannot detect.",
            },
        },
    },
}

_M365_CHAT_SCHEMA = {
    "name": "m365_copilot_chat",
    "description": "Send a hard coding problem to Microsoft 365 Copilot (gpt-5.5-think-deeper) and get a suggested solution, edit, or plan. Use this when you need deep reasoning, complex debugging, architecture advice, or non-trivial code generation.",
    "parameters": {
        "type": "object",
        "properties": {
            "prompt": {
                "type": "string",
                "description": "The full problem / request. Include all relevant context.",
            },
            "model": {"type": "string", "description": "Optional model override."},
            "temperature": {"type": "number"},
            "max_tokens": {"type": "integer", "description": "Optional maximum tokens (default 4000)."},
            "include_reasoning": {"type": "boolean", "description": "If true, include the model reasoning block."},
        },
        "required": ["prompt"],
    },
}

_M365_SUGGEST_EDIT_SCHEMA = {
    "name": "m365_copilot_suggest_edit",
    "description": "Ask GPT 5.5 Think Deeper to suggest an exact edit for a specific file.",
    "parameters": {
        "type": "object",
        "properties": {
            "file_path": {"type": "string"},
            "current_content": {"type": "string"},
            "instruction": {"type": "string"},
            "model": {"type": "string"},
            "temperature": {"type": "number"},
            "max_tokens": {"type": "integer"},
            "include_reasoning": {"type": "boolean"},
        },
        "required": ["file_path", "current_content", "instruction"],
    },
}

_M365_HISTORY_SCHEMA = {
    "name": "m365_copilot_history",
    "description": "List recent M365 Copilot conversations if available.",
    "parameters": {"type": "object", "properties": {}},
}

_M365_RESET_SCHEMA = {
    "name": "m365_copilot_reset",
    "description": "Reset the Copilot conversation context.",
    "parameters": {"type": "object", "properties": {}},
}


def _server_is_up() -> bool:
    try:
        with urllib.request.urlopen(f"{TOOLS_BASE}/health", timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False


def _ensure_server() -> None:
    if _server_is_up():
        return

    if not TOOLS_SERVER_JS.exists():
        raise RuntimeError(f"tools-server.js not found at {TOOLS_SERVER_JS}. Set MCP_REPO env var.")

    logger.info("Starting m365-copilot-mcp tools-server.js...")
    # Detached, long-lived process. stderr goes to /dev/null; use the Node server log.
    subprocess.Popen(
        ["node", str(TOOLS_SERVER_JS)],
        cwd=str(TOOLS_REPO),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )

    # Wait up to 10s for the server to come up.
    deadline = time.time() + 10
    while time.time() < deadline:
        if _server_is_up():
            return
        time.sleep(0.5)
    raise RuntimeError("tools-server.js failed to start within 10 seconds")


def _call(name: str, arguments: Dict[str, Any]) -> str:
    _ensure_server()
    payload = json.dumps({"name": name, "arguments": arguments}).encode("utf-8")
    req = urllib.request.Request(
        f"{TOOLS_BASE}/tools/call",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            result = json.loads(exc.read().decode("utf-8"))
        except Exception:
            return tool_error(f"M365 tool HTTP error: {exc.code}")
    except Exception as exc:
        return tool_error(f"M365 tool call failed: {exc}")

    if not isinstance(result, dict):
        return tool_error("Invalid response from tools-server")

    if result.get("isError"):
        text = result.get("content", [{}])[0].get("text", "unknown error")
        return tool_error(text)

    text = result.get("content", [{}])[0].get("text", "")
    return tool_result(text)


async def _handle_m365_status(*, deep_check: bool = False, **_kwargs) -> str:
    return _call("m365_copilot_status", {"deep_check": deep_check})


async def _handle_m365_chat(*, prompt: str, **kwargs) -> str:
    return _call("m365_copilot_chat", {"prompt": prompt, **kwargs})


async def _handle_m365_suggest_edit(*, file_path: str, current_content: str, instruction: str, **kwargs) -> str:
    return _call("m365_copilot_suggest_edit", {
        "file_path": file_path,
        "current_content": current_content,
        "instruction": instruction,
        **kwargs,
    })


async def _handle_m365_history(**_kwargs) -> str:
    return _call("m365_copilot_history", {})


async def _handle_m365_reset(**_kwargs) -> str:
    return _call("m365_copilot_reset", {})


def register(ctx) -> None:
    """Register native M365 Copilot tools into Hermes."""
    ctx.register_tool(
        name="m365_copilot_status",
        toolset="m365_copilot_native",
        schema=_M365_STATUS_SCHEMA,
        handler=_handle_m365_status,
        emoji="☁️",
    )
    ctx.register_tool(
        name="m365_copilot_chat",
        toolset="m365_copilot_native",
        schema=_M365_CHAT_SCHEMA,
        handler=_handle_m365_chat,
        emoji="🧠",
    )
    ctx.register_tool(
        name="m365_copilot_suggest_edit",
        toolset="m365_copilot_native",
        schema=_M365_SUGGEST_EDIT_SCHEMA,
        handler=_handle_m365_suggest_edit,
        emoji="✏️",
    )
    ctx.register_tool(
        name="m365_copilot_history",
        toolset="m365_copilot_native",
        schema=_M365_HISTORY_SCHEMA,
        handler=_handle_m365_history,
        emoji="📜",
    )
    ctx.register_tool(
        name="m365_copilot_reset",
        toolset="m365_copilot_native",
        schema=_M365_RESET_SCHEMA,
        handler=_handle_m365_reset,
        emoji="🔄",
    )
