#!/usr/bin/env node
/**
 * HTTP tools server for Hermes native integration.
 *
 * This is an alternative to the stdio MCP server. It runs as a long-lived
 * background process, exposes the same tools over HTTP, and uses the fast
 * WebSocket relay path internally. Hermes calls it via the bundled Python
 * plugin instead of spawning an MCP subprocess per turn.
 *
 * Endpoints:
 *   GET  /health              -> { status: 'ok', relay_url, relay_ready }
 *   GET  /tools/list          -> { tools: [...] }
 *   POST /tools/call          -> { content: [{type:'text', text}], isError? }
 *
 * Environment (read from .env):
 *   RELAY_URL                 HTTP relay API (default http://127.0.0.1:9000)
 *   RELAY_WS_URL              WebSocket relay (default ws://127.0.0.1:8765)
 *   MCP_USE_FAST_WS           Use WebSocket path (default true)
 *   M365_MODEL                Default model (default gpt-5.5-think-deeper)
 */

const http = require('http');
const path = require('path');
const { loadEnvFile } = require('./lib/env');
const { RelayClient } = require('./lib/relay-client');
const { relayChat } = require('./lib/fast-client');

loadEnvFile(path.join(__dirname, '.env'));

const RELAY_URL = process.env.RELAY_URL || 'http://127.0.0.1:9000';
const RELAY_API_KEY = process.env.RELAY_API_KEY || null;
const DEFAULT_MODEL = process.env.M365_MODEL || 'gpt-5.5-think-deeper';
const MCP_USE_FAST_WS = process.env.MCP_USE_FAST_WS !== 'false';

const client = new RelayClient({ baseUrl: RELAY_URL, apiKey: RELAY_API_KEY });

const TOOLS = [
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
        prompt: { type: 'string', description: 'The full problem / request.' },
        model: { type: 'string', description: 'Optional model override.' },
        temperature: { type: 'number' },
        max_tokens: { type: 'integer', description: 'Optional maximum tokens (default 4000).' },
        include_reasoning: { type: 'boolean', description: 'If true, include reasoning block.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'm365_copilot_suggest_edit',
    description: 'Ask GPT 5.5 Think Deeper to suggest an exact edit for a specific file.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        current_content: { type: 'string' },
        instruction: { type: 'string' },
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
];

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

async function handleStatus(args) {
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
    }
  }

  return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
}

async function handleChat(args) {
  if (!args.prompt || typeof args.prompt !== 'string' || args.prompt.trim().length === 0) {
    return { content: [{ type: 'text', text: 'Missing required argument: prompt (non-empty string).' }], isError: true };
  }
  const model = args.model || DEFAULT_MODEL;
  const maxTokens = args.max_tokens || 4000;
  const includeReasoning = args.include_reasoning === true;
  const useFast = MCP_USE_FAST_WS;

  let result;
  if (useFast) {
    result = await relayChat(args.prompt, { model, maxWaitMs: Math.max(maxTokens * 50, 180000) });
  } else {
    result = await client.chat(args.prompt, { model, temperature: args.temperature ?? 0.2, max_tokens: maxTokens, include_reasoning: includeReasoning });
  }
  const text = formatResult(result, includeReasoning) + (result.ttftMs != null ? `\n\n[ttft: ${result.ttftMs}ms]` : '');
  return { content: [{ type: 'text', text }] };
}

async function handleSuggestEdit(args) {
  for (const key of ['file_path', 'current_content', 'instruction']) {
    if (!args[key] || typeof args[key] !== 'string' || args[key].trim().length === 0) {
      return { content: [{ type: 'text', text: `Missing required argument: ${key} (non-empty string).` }], isError: true };
    }
  }
  const prompt = buildEditPrompt(args.file_path, args.current_content, args.instruction);
  const model = args.model || DEFAULT_MODEL;
  const maxTokens = args.max_tokens || 4000;
  const includeReasoning = args.include_reasoning === true;
  const useFast = MCP_USE_FAST_WS;

  let result;
  if (useFast) {
    result = await relayChat(prompt, { model, maxWaitMs: Math.max(maxTokens * 50, 180000) });
  } else {
    result = await client.chat(prompt, { model, temperature: args.temperature ?? 0.2, max_tokens: maxTokens, include_reasoning: includeReasoning });
  }
  const text = formatResult(result, includeReasoning) + (result.ttftMs != null ? `\n\n[ttft: ${result.ttftMs}ms]` : '');
  return { content: [{ type: 'text', text }] };
}

async function handleToolCall(name, args) {
  switch (name) {
    case 'm365_copilot_status': return handleStatus(args);
    case 'm365_copilot_chat': return handleChat(args);
    case 'm365_copilot_suggest_edit': return handleSuggestEdit(args);
    case 'm365_copilot_history': {
      const list = await client.history();
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    }
    case 'm365_copilot_reset': {
      return { content: [{ type: 'text', text: 'Context reset (each chat call starts a fresh conversation).' }] };
    }
    default: return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 10 * 1024 * 1024) reject(new Error('body too large')); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

  res.setHeader('Content-Type', 'application/json');

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      const health = await client.health().catch(() => ({ status: 'unavailable' }));
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok', relay_url: RELAY_URL, relay_ready: health.status === 'ok' }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/tools/list') {
      res.writeHead(200);
      res.end(JSON.stringify({ tools: TOOLS }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/tools/call') {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const { name, arguments: args = {} } = payload;
      if (!name) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'missing name' }));
        return;
      }
      const result = await handleToolCall(name, args);
      res.writeHead(result.isError ? 500 : 200);
      res.end(JSON.stringify(result));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (e) {
    console.error('[tools-server] error:', e);
    res.writeHead(500);
    res.end(JSON.stringify({ content: [{ type: 'text', text: e.message }], isError: true }));
  }
});

const PORT = process.env.MCP_TOOLS_PORT || 9100;
const HOST = process.env.MCP_TOOLS_HOST || '127.0.0.1';

server.listen(PORT, HOST, () => {
  console.error(`[tools-server] M365 Copilot HTTP tools server listening on http://${HOST}:${PORT}`);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
