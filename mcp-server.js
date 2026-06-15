#!/usr/bin/env node
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { RelayClient } = require('./lib/relay-client');
const { AuthManager } = require('./lib/auth-manager');

const RELAY_URL = process.env.RELAY_URL || 'http://127.0.0.1:9000';
const RELAY_API_KEY = process.env.RELAY_API_KEY || null;
const G365_RELAY_REPO = process.env.G365_RELAY_REPO || null;
const AUTH_MODE = process.env.AUTH_MODE || (process.env.M365_EMAIL ? 'credentials' : 'existing');
const DEFAULT_MODEL = process.env.M365_MODEL || 'gpt-5.5-think-deeper';

const client = new RelayClient({ baseUrl: RELAY_URL, apiKey: RELAY_API_KEY });
const auth = new AuthManager({ relayUrl: RELAY_URL, relayRepo: G365_RELAY_REPO, mode: AUTH_MODE });

async function main() {
  // Ensure relay is reachable before starting MCP transport.
  try {
    await auth.ensureRelayRunning();
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
        description: 'Check whether the M365 Copilot relay is healthy and ready.',
        inputSchema: { type: 'object', properties: {} },
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
    const { name, arguments: args } = request.params;

    if (name === 'm365_copilot_status') {
      try {
        const health = await client.health();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ ready: health.status === 'ok', ...health }, null, 2),
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
      const result = await client.chat(prompt, { model, temperature, max_tokens: maxTokens, include_reasoning: includeReasoning });
      const text = formatResult(result, includeReasoning);
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

main().catch(err => {
  console.error('[mcp] Fatal error:', err);
  process.exit(1);
});

process.on('SIGINT', () => {
  auth.stopRelay();
  process.exit(0);
});

process.on('SIGTERM', () => {
  auth.stopRelay();
  process.exit(0);
});
