const http = require('http');
const path = require('path');
const { URL } = require('url');
const { v4: uuidv4 } = require('uuid');
const { DirectChat } = require('./direct-chat');
const { DirectHistory } = require('./direct-history');

const DEFAULT_MAX_CHARS = 100000;

const MODEL_MAP = {
  'gpt-5.5-think-deeper': 'Gpt_5_5_Reasoning',
  'gpt-5.5-reasoning': 'Gpt_5_5_Reasoning',
  'gpt-5.5-think': 'Gpt_5_5_Reasoning',
  'gpt-5.5-quick': 'Gpt_5_5_Chat',
  'gpt-5.5-chat': 'Gpt_5_5_Chat',
  'gpt-5.5': 'Gpt_5_5_Chat',
  'gpt-4o': 'Gpt_5_5_Chat',
  'gpt-4': 'Gpt_5_5_Chat',
  'gpt-3.5-turbo': 'Gpt_5_5_Chat',
};

function resolveTone(modelName) {
  return MODEL_MAP[(modelName || '').toLowerCase()] || 'Gpt_5_5_Reasoning';
}

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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

function createOpenAiServer({ getTemplateUrl, semaphore, apiKey, port = 9000, host = '0.0.0.0', maxChars = DEFAULT_MAX_CHARS, requestLogPath = null }) {
  let requestCount = 0;
  let firstRequestAt = null;
  const fs = requestLogPath ? require('fs') : null;

  function createLogFile() {
    if (!fs || !requestLogPath) return;
    try {
      const dir = path.dirname(requestLogPath);
      if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
    } catch (e) {}
  }

  function logRequest(model, promptChars, ok, err) {
    requestCount++;
    if (!firstRequestAt) firstRequestAt = Date.now();
    if (!fs) return;
    createLogFile();
    const line = JSON.stringify({
      t: new Date().toISOString(),
      model,
      promptChars,
      ok,
      err: err || null,
      totalCount: requestCount,
      elapsedMs: Date.now() - firstRequestAt,
    }) + '\n';
    fs.appendFileSync(requestLogPath, line);
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

    if (path === '/health' && req.method === 'GET') {
      const tpl = getTemplateUrl();
      json(res, 200, {
        status: tpl ? 'ok' : 'not_ready',
        has_template: !!tpl,
        queued: semaphore.size(),
        max_concurrency: semaphore.max,
        request_count: requestCount,
        models: Object.keys(MODEL_MAP).filter((k, i, a) => a.indexOf(k) === i),
      });
      return;
    }

    const auth = req.headers['authorization'] || '';
    if (path !== '/health' && apiKey && (!auth.startsWith('Bearer ') || auth.slice(7) !== apiKey)) {
      json(res, 401, { error: { message: 'Invalid API key', type: 'authentication_error' } });
      return;
    }

    if (path === '/v1/conversations' && req.method === 'GET') {
      const templateUrl = getTemplateUrl();
      if (!templateUrl) {
        json(res, 503, { error: { message: 'Relay not ready', type: 'service_unavailable' } });
        return;
      }
      try {
        const dh = new DirectHistory({ templateUrl });
        const conversations = await dh.getHistory(30000);
        json(res, 200, { object: 'list', data: conversations });
      } catch (e) {
        console.error('[openai] History error:', e.message);
        json(res, 502, { error: { message: e.message, type: 'relay_error' } });
      }
      return;
    }

    if (path === '/v1/models' && req.method === 'GET') {
      const now = Math.floor(Date.now() / 1000);
      const models = Object.keys(MODEL_MAP).map((id, i) => ({
        id,
        object: 'model',
        created: now - i,
        owned_by: 'g365',
      }));
      json(res, 200, { object: 'list', data: models });
      return;
    }

    if (path === '/v1/chat/completions' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
        json(res, 400, { error: { message: 'messages array required', type: 'invalid_request_error' } });
        return;
      }

      const templateUrl = getTemplateUrl();
      if (!templateUrl) {
        json(res, 503, { error: { message: 'Relay not ready — no M365 template captured yet', type: 'service_unavailable' } });
        return;
      }

      const totalChars = countChars(body.messages);
      if (totalChars > maxChars) {
        json(res, 400, {
          error: { message: `Input too long: ${totalChars} chars (limit ${maxChars})`, type: 'invalid_request_error' },
        });
        return;
      }

      const requestedModel = body.model || 'gpt-5.5-think-deeper';
      const tone = resolveTone(requestedModel);
      const stream = body.stream === true;
      const systemPrompt = Array.isArray(body.messages) && body.messages[0]?.role === 'system'
        ? body.messages[0].content + '\n\n'
        : '';
      const lastUser = body.messages.slice().reverse().find(m => m.role === 'user');
      const promptText = systemPrompt + (lastUser ? lastUser.content : '');

      try {
        const release = await semaphore.acquire();
        try {
          if (stream) {
            sse(res);
            const id = 'chatcmpl-' + uuidv4().replace(/-/g, '').slice(0, 14);
            const created = Math.floor(Date.now() / 1000);
            let ended = false;
            let finishReason = null;
            let fullText = '';

            function writeChunk({ content = null, reasoning_content = null, finish_reason = null }) {
              if (ended) return;
              const chunk = {
                id,
                object: 'chat.completion.chunk',
                created,
                model: requestedModel,
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: finish_reason || null,
                }],
              };
              if (content) chunk.choices[0].delta.content = content;
              if (reasoning_content) chunk.choices[0].delta.reasoning_content = reasoning_content;
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }

            function endStream(reason = 'stop') {
              if (ended) return;
              ended = true;
              writeChunk({ finish_reason: reason });
              res.write('data: [DONE]\n\n');
              res.end();
            }

            const dc = new DirectChat({ templateUrl, tone });
            let settled = false;
            const timeout = setTimeout(() => {
              if (!settled) {
                settled = true;
                console.warn('[openai] Stream timeout');
                logRequest(requestedModel, totalChars, true, 'timeout');
                endStream('stop');
              }
            }, 180000);

            function finish() {
              clearTimeout(timeout);
              if (settled) return;
              settled = true;
              logRequest(requestedModel, totalChars, true, null);
              endStream('stop');
            }

            function fail(err) {
              clearTimeout(timeout);
              if (settled) return;
              settled = true;
              console.error('[openai] DirectChat error:', err);
              logRequest(requestedModel, totalChars, false, String(err));
              endStream('stop');
            }

            dc.onDelta = (delta) => {
              if (settled || ended) return;
              if (typeof delta === 'object' && delta.type === 'message') {
                const suffix = delta.text.substring(fullText.length);
                fullText = delta.text;
                if (suffix) writeChunk({ content: suffix });
              } else {
                fullText += delta;
                writeChunk({ content: delta });
              }
            };
            dc.onReasoningDelta = (text) => {
              if (settled || ended) return;
              writeChunk({ reasoning_content: text });
            };
            dc.onDone = finish;
            dc.onError = fail;

            dc.send(promptText);
          } else {
            const result = await new Promise((resolve, reject) => {
              const dc = new DirectChat({ templateUrl, tone });
              let text = '';
              let reasoning = '';
              let done = false;
              const timeout = setTimeout(() => {
                if (!done) { done = true; logRequest(requestedModel, totalChars, false, 'timeout'); reject(new Error('Request timed out')); }
              }, 180000);

              dc.onDelta = (delta) => {
                if (done) return;
                if (typeof delta === 'object' && delta.type === 'message') text = delta.text || text;
                else text += delta;
              };
              dc.onReasoningDelta = (t) => { if (!done) reasoning += t; };
              dc.onDone = () => {
                if (done) return;
                done = true;
                clearTimeout(timeout);
                logRequest(requestedModel, totalChars, true, null);
                resolve({ text, reasoning });
              };
              dc.onError = (err) => {
                if (done) return;
                done = true;
                clearTimeout(timeout);
                logRequest(requestedModel, totalChars, false, String(err));
                reject(new Error(err));
              };
              dc.send(promptText);
            });

            const promptTokens = Math.ceil(totalChars / 4);
            const completionTokens = Math.ceil(result.text.length / 4);
            const content = result.reasoning
              ? `<think>\n${result.reasoning}\n</think>\n\n${result.text}`
              : result.text;

            json(res, 200, {
              id: 'chatcmpl-' + uuidv4().replace(/-/g, '').slice(0, 14),
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: requestedModel,
              choices: [{
                index: 0,
                message: { role: 'assistant', content },
                finish_reason: 'stop',
              }],
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
              },
            });
          }
        } finally {
          release();
        }
      } catch (err) {
        console.error('[openai] Chat error:', err.message);
        json(res, 502, { error: { message: err.message, type: 'relay_error' } });
      }
      return;
    }

    json(res, 404, { error: { message: 'Not found', type: 'invalid_request_error' } });
  });

  server.listen(port, host, () => {
    console.log(`OpenAI-compatible API: http://${host}:${port}`);
    if (apiKey) console.log('API key authentication: enabled');
    else console.log('API key authentication: disabled (set OPENAI_API_KEY to enable)');
  });

  return { server };
}

module.exports = { createOpenAiServer, resolveTone, MODEL_MAP };
