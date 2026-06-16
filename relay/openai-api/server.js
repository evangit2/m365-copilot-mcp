const http = require('http');
const WebSocket = require('ws');

const RELAY_WS_URL  = process.env.G365_RELAY_URL || 'ws://127.0.0.1:8765';
const API_PORT      = parseInt(process.env.OPENAI_API_PORT || '9000', 10);
const API_KEY       = process.env.OPENAI_API_KEY || 'sk-test-key';
const MAX_CHARS     = parseInt(process.env.MAX_CHARS || '128', 10);
const DEFAULT_MODEL = 'gpt-3.5-turbo';

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', chunk => buf += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(buf)); } catch (e) { resolve(null); }
    });
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

function sse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });
}

function countChars(messages) {
  return messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
}

async function chatViaRelay(messages, stream, onDelta) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_WS_URL);
    let accumulated = '';
    let ready = false;
    let finished = false;
    let timeout;

    function cleanup() {
      if (timeout) clearTimeout(timeout);
      try { ws.terminate(); } catch (e) {}
    }

    timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Relay connection timeout'));
    }, 30000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'new', model: 'gpt-5.5-think-deeper' }));
    });

    ws.on('message', (raw) => {
      if (finished) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

      if (msg.type === 'ready') {
        ready = true;
        const lastUser = messages.slice().reverse().find(m => m.role === 'user');
        const text = lastUser ? lastUser.content : '';
        ws.send(JSON.stringify({ type: 'chat', text }));
      } else if (msg.type === 'delta') {
        const text = msg.text || '';
        accumulated += text;
        if (stream && onDelta) onDelta(text);
      } else if (msg.type === 'message') {
        accumulated = msg.text || accumulated;
      } else if (msg.type === 'done') {
        finished = true;
        cleanup();
        resolve({ text: accumulated });
      } else if (msg.type === 'error') {
        finished = true;
        cleanup();
        reject(new Error(msg.message || msg.code || 'Relay error'));
      }
    });

    ws.on('error', (err) => {
      if (!finished) { finished = true; cleanup(); reject(err); }
    });

    ws.on('close', () => {
      if (!finished) {
        finished = true;
        cleanup();
        if (ready) resolve({ text: accumulated });
        else reject(new Error('WebSocket closed before ready'));
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }
  // ── Auth ──
  const auth = req.headers['authorization'] || '';
  if (path !== '/health' && (!auth.startsWith('Bearer ') || auth.slice(7) !== API_KEY)) {
    json(res, 401, { error: { message: 'Invalid API key', type: 'authentication_error' } });
    return;
  }

  if (path === '/v1/models' && req.method === 'GET') {
    json(res, 200, {
      object: 'list',
      data: [{ id: DEFAULT_MODEL, object: 'model', created: 1672531200, owned_by: 'g365' }],
    });
    return;
  }

  if (path === '/v1/chat/completions' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      json(res, 400, { error: { message: 'messages array required', type: 'invalid_request_error' } });
      return;
    }

    const totalChars = countChars(body.messages);
    if (totalChars > MAX_CHARS) {
      json(res, 400, {
        error: { message: `Input too long: ${totalChars} chars (limit ${MAX_CHARS})`, type: 'invalid_request_error' },
      });
      return;
    }

    const stream = body.stream === true;

    try {
      if (stream) {
        sse(res);
        let ended = false;

        function writeChunk(text, finishReason = null) {
          if (ended) return;
          const id = 'chatcmpl-' + Math.random().toString(36).slice(2, 14);
          const chunk = {
            id, object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: body.model || DEFAULT_MODEL,
            choices: [{
              index: 0,
              delta: finishReason ? {} : { content: text },
              finish_reason: finishReason,
            }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }

        function endStream() {
          if (ended) return;
          ended = true;
          writeChunk('', 'stop');
          res.write('data: [DONE]\n\n');
          res.end();
        }

        await chatViaRelay(body.messages, true, (text) => writeChunk(text));
        endStream();
      } else {
        const result = await chatViaRelay(body.messages, false);
        const id = 'chatcmpl-' + Math.random().toString(36).slice(2, 14);
        const promptTokens = Math.ceil(totalChars / 4);
        const completionTokens = Math.ceil(result.text.length / 4);
        json(res, 200, {
          id, object: 'chat.completion', created: Math.floor(Date.now() / 1000),
          model: body.model || DEFAULT_MODEL,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: result.text },
            finish_reason: 'stop',
          }],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        });
      }
    } catch (err) {
      json(res, 502, { error: { message: err.message, type: 'relay_error' } });
    }
    return;
  }

  if (path === '/health' && req.method === 'GET') {
    json(res, 200, { status: 'ok', model: DEFAULT_MODEL, max_chars: MAX_CHARS, relay: RELAY_WS_URL });
    return;
  }

  json(res, 404, { error: { message: 'Not found', type: 'invalid_request_error' } });
});

server.listen(API_PORT, () => {
  console.log(`OpenAI-compatible API: http://127.0.0.1:${API_PORT}`);
  console.log(`Relay target: ${RELAY_WS_URL}`);
  console.log(`Max chars: ${MAX_CHARS}`);
});
