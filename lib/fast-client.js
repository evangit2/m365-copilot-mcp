const WebSocket = require('ws');
const http = require('http');
const { URL } = require('url');

const RELAY_WS_URL = process.env.RELAY_WS_URL || 'ws://127.0.0.1:8765';
const RELAY_URL = process.env.RELAY_URL || 'http://127.0.0.1:9000';
const RELAY_API_KEY = process.env.RELAY_API_KEY || null;

function toneForModel(model) {
  const m = String(model || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (m.includes('reasoning') || m.includes('thinkdeeper') || m.includes('thinkdeep')) return 'Gpt_5_5_Reasoning';
  if (m.includes('quick') || m.includes('chat')) return 'Gpt_5_5_Chat';
  return 'Gpt_5_5_Reasoning';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function httpChat(prompt, { model = 'gpt-5.5-think-deeper', max_tokens = 4000, temperature = 0.2 } = {}) {
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature,
    max_tokens,
  });
  const url = new URL('/v1/chat/completions', RELAY_URL);
  const reqOpts = {
    method: 'POST',
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...(RELAY_API_KEY ? { Authorization: `Bearer ${RELAY_API_KEY}` } : {}),
    },
    timeout: 120000,
  };
  return new Promise((resolve, reject) => {
    const req = http.request(reqOpts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.message?.content ?? '';
          resolve({ content, reasoning: '' });
        } catch (e) {
          reject(new Error(`HTTP fallback parse failed: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => reject(new Error('HTTP fallback timeout')));
    req.write(body);
    req.end();
  });
}

function relayChatOnce(prompt, { model = 'gpt-5.5-think-deeper', maxWaitMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_WS_URL);
    const tone = toneForModel(model);
    let startedAt = null;
    let firstAt = null;
    let done = false;
    let finalText = '';
    let reasoningText = '';
    let sentNew = false;

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try { ws.close(); } catch (e) {}
        reject(new Error('Relay chat timed out'));
      }
    }, maxWaitMs);

    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch (e) {}
      resolve({
        content: finalText,
        reasoning: reasoningText,
        ttftMs: firstAt && startedAt ? firstAt - startedAt : null,
        totalMs: startedAt ? Date.now() - startedAt : null,
      });
    }

    function fail(err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch (e) {}
      reject(err);
    }

    ws.on('open', () => {
      if (!sentNew) {
        sentNew = true;
        ws.send(JSON.stringify({ type: 'new', model: 'gpt-5.5-think-deeper', tone }));
      }
    });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (e) { return; }

      if (msg.type === 'ready') {
        startedAt = Date.now();
        ws.send(JSON.stringify({ type: 'chat', text: prompt }));
        return;
      }

      if (msg.type === 'reasoning_delta' && typeof msg.text === 'string') {
        if (!firstAt) firstAt = Date.now();
        reasoningText += msg.text;
        return;
      }

      if ((msg.type === 'delta' || msg.type === 'message') && typeof msg.text === 'string') {
        if (!firstAt) firstAt = Date.now();
        const candidate = msg.text;
        if (candidate.length >= finalText.length) {
          finalText = candidate;
        }
        return;
      }

      if (msg.type === 'done') {
        finish();
      }

      if (msg.type === 'error') {
        fail(new Error(msg.error || msg.message || 'Relay chat error'));
      }
    });

    ws.on('error', (err) => {
      fail(new Error('Relay WebSocket error: ' + err.message));
    });

    ws.on('close', (code, reason) => {
      if (done) return;
      if (!startedAt) {
        fail(new Error(`Relay WebSocket closed before ready (code ${code}${reason ? ' ' + reason : ''})`));
      } else {
        finish();
      }
    });
  });
}

async function relayChat(prompt, options = {}) {
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 1500;
  let lastError = null;

  for (let i = 0; i <= retries; i++) {
    try {
      return await relayChatOnce(prompt, options);
    } catch (err) {
      lastError = err;
      const isRecoverable = /timed out|closed before ready|WebSocket error|Substrate|ECONNREFUSED/i.test(err.message);
      if (!isRecoverable || i >= retries) break;
      await sleep(retryDelayMs * (i + 1));
    }
  }

  // Fallback to HTTP OpenAI-compatible relay API if WebSocket path fails.
  try {
    const httpResult = await httpChat(prompt, options);
    return { ...httpResult, ttftMs: null, totalMs: null, fallback: true };
  } catch (httpErr) {
    throw new Error(`Substrate connection error: ${lastError.message} (HTTP fallback also failed: ${httpErr.message})`);
  }
}

module.exports = { relayChat, toneForModel };
