#!/usr/bin/env node
const path = require('path');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { RelayClient } = require('./lib/relay-client');
const { AuthManager } = require('./lib/auth-manager');
const { loadEnvFile } = require('./lib/env');
const { relayChat } = require('./lib/fast-client');

// Hermes usually spawns the MCP server directly, not through start.sh, so load
// local .env here too. Explicit environment variables still take precedence.
loadEnvFile(path.join(__dirname, '.env'));

const RELAY_URL = process.env.RELAY_URL || 'http://127.0.0.1:9000';
const RELAY_API_KEY = process.env.RELAY_API_KEY || null;
const G365_RELAY_REPO = process.env.G365_RELAY_REPO || null;
const AUTH_MODE = process.env.AUTH_MODE || (process.env.M365_EMAIL ? 'credentials' : 'existing');
const DEFAULT_MODEL = process.env.M365_MODEL || 'gpt-5.5-think-deeper';

const client = new RelayClient({ baseUrl: RELAY_URL, apiKey: RELAY_API_KEY });
const auth = new AuthManager({ relayUrl: RELAY_URL, relayRepo: G365_RELAY_REPO, mode: AUTH_MODE });
let shuttingDown = false;
let startedRelay = false;

function isBrokenPipeError(err) {
  return err && (
    err.code === 'EPIPE' ||
    err.code === 'ERR_STREAM_DESTROYED' ||
    err.code === 'ECONNRESET'
  );
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (startedRelay) {
    try { auth.stopRelay(); } catch (e) {}
  }
  setImmediate(() => process.exit(code));
}

function handleFatalError(err) {
  if (isBrokenPipeError(err)) {
    shutdown(0);
    return;
  }
  console.error('[mcp] Fatal error:', err);
  shutdown(1);
}

// If the MCP client goes away while a response is being written, Node emits an
// error on process.stdout. Without this listener, stdio transport writes crash
// with an unhandled EPIPE stack trace in Hermes logs.
process.stdout.on('error', handleFatalError);
process.stdin.on('end', () => shutdown(0));
process.stdin.on('close', () => shutdown(0));
process.on('uncaughtException', handleFatalError);
process.on('unhandledRejection', (reason, promise) => {
  console.error('[mcp] Unhandled rejection at:', promise, 'reason:', reason);
});

async function main() {
  // Ensure relay is reachable before starting MCP transport.
  let relayState;
  try {
    relayState = await auth.ensureRelayRunning();
    startedRelay = relayState?.started === true;
  } catch (e) {
    console.error(`[mcp] Warning: could not confirm relay readiness: ${e.message}`);
    // Continue anyway; tools will report status errors.
  }

  const server = new Server(
    {
      name: 'm365-copilot-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'm365_copilot_status',
        description: 'Check whether the M365 Copilot relay is healthy and ready. Set deep_check=true to verify the captured Copilot session with a tiny chat request.',
        inputSchema: {
          type: 'object',
          properties: {
            deep_check: {
              type: 'boolean',
              description: 'If true, send a tiny chat completion to catch stale auth tokens that /health cannot detect.',
            },
          },
        },
      },
      {
        name: 'm365_copilot_chat',
        description: `Send a hard coding problem to Microsoft 365 Copilot (${DEFAULT_MODEL}) and get a suggested solution, edit, or plan. Use this when you need deep reasoning, complex debugging, architecture advice, or non-trivial code generation.`,
        inputSchema: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'The full problem / request. Include all relevant context: file paths, error messages, current code snippets, and desired behavior.',
            },
            model: {
              type: 'string',
              description: 'Optional model override. Default is gpt-5.5-think-deeper.',
            },
            temperature: {
              type: 'number',
              description: 'Optional sampling temperature (0.0 - 1.0). Lower is more deterministic.',
            },
            max_tokens: {
              type: 'integer',
              description: 'Optional maximum tokens for the response (default 4000).',
            },
            include_reasoning: {
              type: 'boolean',
              description: 'If true, include the model internal reasoning block in the response.',
            },
          },
          required: ['prompt'],
        },
      },
      {
        name: 'm365_copilot_suggest_edit',
        description: 'Ask GPT 5.5 Think Deeper to suggest an exact edit for a specific file, then return it as a ready-to-apply patch description.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'Absolute or relative path of the file to edit.',
            },
            current_content: {
              type: 'string',
              description: 'The current content of the file (or the relevant excerpt).',
            },
            instruction: {
              type: 'string',
              description: 'What change to make.',
            },
            model: { type: 'string' },
            temperature: { type: 'number' },
            max_tokens: { type: 'integer' },
            include_reasoning: { type: 'boolean' },
          },
          required: ['file_path', 'current_content', 'instruction'],
        },
      },
      {
        name: 'm365_copilot_history',
        description: 'List recent M365 Copilot conversations if available.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'm365_copilot_reset',
        description: 'Reset the Copilot conversation context.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = rawArgs || {};

    if (name === 'm365_copilot_status') {
      try {
        const health = await client.health();
        const status = { ready: health.status === 'ok', ...health };

        if (args?.deep_check === true) {
          try {
            const probe = await relayChat('MCP status deep check. Reply with exactly: MCP_STATUS_OK', {
              model: DEFAULT_MODEL,
              maxWaitMs: 60000,
            });
            status.chat_ready = typeof probe.content === 'string' && probe.content.trim().length > 0;
            status.chat_probe = probe.content.slice(0, 200);
            if (probe.ttftMs != null) status.chat_ttft_ms = probe.ttftMs;
            if (probe.totalMs != null) status.chat_total_ms = probe.totalMs;
          } catch (e) {
            status.chat_ready = false;
            status.chat_error = e.message;
            status.chat_error_code = e.code;
          }
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(status, null, 2),
          }],
        };
      } catch (e) {
        return {
          content: [{ type: 'text', text: `Relay unavailable: ${e.message}` }],
          isError: true,
        };
      }
    }

    if (name === 'm365_copilot_history') {
      try {
        const list = await client.history();
        return {
          content: [{ type: 'text', text: JSON.stringify(list, null, 2) }],
        };
      } catch (e) {
        return {
          content: [{ type: 'text', text: `History error: ${e.message}` }],
          isError: true,
        };
      }
    }

    if (name === 'm365_copilot_reset') {
      // The relay creates a new ConversationId per request, so reset is implicit.
      return {
        content: [{ type: 'text', text: 'Context reset (each m365_copilot_chat call starts a fresh conversation).' }],
      };
    }

    let prompt = '';
    let model = args.model || DEFAULT_MODEL;
    let temperature = args.temperature ?? 0.2;
    let maxTokens = args.max_tokens || 4000;
    let includeReasoning = args.include_reasoning === true;

    if (name === 'm365_copilot_chat') {
      if (!args.prompt || typeof args.prompt !== 'string' || args.prompt.trim().length === 0) {
        return {
          content: [{ type: 'text', text: 'Missing required argument: prompt (non-empty string).' }],
          isError: true,
        };
      }
      prompt = args.prompt;
    } else if (name === 'm365_copilot_suggest_edit') {
      for (const key of ['file_path', 'current_content', 'instruction']) {
        if (!args[key] || typeof args[key] !== 'string' || args[key].trim().length === 0) {
          return {
            content: [{ type: 'text', text: `Missing required argument: ${key} (non-empty string).` }],
            isError: true,
          };
        }
      }
      prompt = buildEditPrompt(args.file_path, args.current_content, args.instruction);
    } else {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    try {
      const startMs = Date.now();
      const useFast = process.env.MCP_USE_FAST_WS !== 'false';
      let result;
      if (useFast) {
        result = await relayChat(prompt, { model, maxWaitMs: Math.max(maxTokens * 50, 180000) });
      } else {
        result = await client.chat(prompt, { model, temperature, max_tokens: maxTokens, include_reasoning: includeReasoning });
      }
      const text = formatResult(result, includeReasoning) + (result.ttftMs != null ? `\n\n[ttft: ${result.ttftMs}ms]` : '');
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return {
        content: [{ type: 'text', text: `Copilot error: ${e.message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp] M365 Copilot MCP server connected via stdio');
}

function buildEditPrompt(filePath, currentContent, instruction) {
  return `You are helping an autonomous coding agent make an exact edit.

File: ${filePath}

Current content:
\`\`\`
${currentContent}
\`\`\`

Instruction:
${instruction}

Please return ONLY:
1. A brief explanation of the change (1-3 sentences).
2. The exact new file content inside a code block with the language tag.

Do not include diff markers, line numbers, or patch notation unless requested. The agent will apply the exact code block content as the new file contents.`;
}

function formatResult(result, includeReasoning = false) {
  let out = '';
  if (includeReasoning && result.reasoning) {
    out += `Reasoning:\n${result.reasoning}\n\n`;
  }
  out += result.content;
  return out.trim();
}

main().catch(handleFatalError);

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
