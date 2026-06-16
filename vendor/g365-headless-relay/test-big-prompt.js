const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:8765';
const ITERATIONS = parseInt(process.env.ITERATIONS || '6', 10); // every 30s => 3 min
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS || '30000', 10);
const PROMPT_SIZE = parseInt(process.env.PROMPT_SIZE || '15000', 10);
const OUT = process.env.OUT || path.join(__dirname, 'big-prompt-stress.log');

function bigPrompt(n) {
  // repeatable pseudo-content
  const base = "Explain the concept of recursion in programming, including base cases, stack frames, tail recursion, and memory implications. Then discuss how modern compilers and runtimes optimize recursive functions. ";
  let s = "";
  while (s.length < n) s += base + `[chunk ${Math.floor(s.length / base.length)}] `;
  return s.slice(0, n) + "\n\nNow, write a very long, detailed essay expanding on all of the above. Be thorough.";
}

function now() { return new Date().toISOString(); }

async function runChat(i) {
  const prompt = bigPrompt(PROMPT_SIZE);
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    const start = Date.now();
    const metrics = { iteration: i, connectedAt: null, readyAt: null, firstDeltaAt: null, doneAt: null, totalChars: 0, error: null };
    let doneTimer = null;
    let finished = false;
    const CHAT_TIMEOUT = parseInt(process.env.CHAT_TIMEOUT || '180000', 10); // default 3 min for long answers

    function finish(reason) {
      if (finished) return;
      finished = true;
      if (doneTimer) clearTimeout(doneTimer);
      metrics.totalMs = Date.now() - start;
      metrics.reason = reason;
      try { ws.close(); } catch(e){}
      resolve(metrics);
    }

    ws.on('open', () => {
      metrics.connectedAt = Date.now() - start;
      ws.send(JSON.stringify({ type: 'new', model: 'gpt-5.5-think-deeper' }));
      doneTimer = setTimeout(() => finish('timeout'), CHAT_TIMEOUT);
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ready') {
          metrics.readyAt = Date.now() - start;
          ws.send(JSON.stringify({ type: 'chat', text: prompt }));
        }
        if (msg.type === 'delta') {
          if (!metrics.firstDeltaAt) metrics.firstDeltaAt = Date.now() - start;
          metrics.totalChars += (msg.text || "").length;
        }
        if (msg.type === 'done') {
          metrics.doneAt = Date.now() - start;
          finish('done');
        }
        if (msg.type === 'error') {
          metrics.error = msg.message;
          finish('error');
        }
      } catch (e) {
        metrics.error = "parse error: " + e.message;
        finish('parse-error');
      }
    });

    ws.on('error', (err) => {
      metrics.error = err.message;
      finish('ws-error');
    });
    ws.on('close', () => finish('closed'));
  });
}

async function main() {
  const logLines = [`[${now()}] Big prompt stress starting: ${ITERATIONS} iterations, ${INTERVAL_MS}ms interval, prompt ~${PROMPT_SIZE} chars`];
  fs.appendFileSync(OUT, logLines[0] + "\n");

  for (let i = 1; i <= ITERATIONS; i++) {
    const t0 = Date.now();
    const result = await runChat(i);
    const line = `[${now()}] iter=${i} connected=${result.connectedAt}ms ready=${result.readyAt}ms ttfd=${result.firstDeltaAt}ms done=${result.doneAt}ms total=${result.totalMs}ms chars=${result.totalChars} reason=${result.reason} error=${result.error || 'none'}`;
    logLines.push(line);
    fs.appendFileSync(OUT, line + "\n");
    console.log(line);
    const elapsed = Date.now() - t0;
    if (i < ITERATIONS && elapsed < INTERVAL_MS) {
      await new Promise(r => setTimeout(r, INTERVAL_MS - elapsed));
    }
  }

  const summary = `[${now()}] Stress complete. Log: ${OUT}`;
  fs.appendFileSync(OUT, summary + "\n");
  console.log(summary);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
