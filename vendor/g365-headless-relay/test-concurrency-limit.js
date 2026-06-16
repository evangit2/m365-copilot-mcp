const WebSocket = require('ws');

const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:8765';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '10', 10);
const PROMPT = process.env.PROMPT || 'Say hello and confirm which Copilot model you are. Keep it under 50 words.';
const LOGFILE = process.env.LOGFILE || '/home/evan/projects/g365-headless-relay/concurrency-limit.log';

const fs = require('fs');

function now() { return new Date().toISOString(); }

function log(...args) {
  const line = `[${now()}] ` + args.join(' ');
  console.log(line);
  fs.appendFileSync(LOGFILE, line + '\n');
}

function runOne(id) {
  return new Promise((resolve) => {
    const start = Date.now();
    const metrics = { id, connectedAt: null, readyAt: null, firstDeltaAt: null, doneAt: null, text: '', error: null };
    const ws = new WebSocket(WS_URL);
    let doneTimer = null;
    let finished = false;

    function finish(reason, err) {
      if (finished) return;
      finished = true;
      clearTimeout(doneTimer);
      try { ws.close(); } catch(e){}
      metrics.reason = reason;
      if (err) metrics.error = err;
      resolve(metrics);
    }

    ws.on('open', () => {
      metrics.connectedAt = Date.now() - start;
      ws.send(JSON.stringify({ type: 'new', model: 'gpt-5.5-think-deeper' }));
      doneTimer = setTimeout(() => finish('timeout'), 60000);
    });

    ws.on('message', (raw) => {
      const msgs = JSON.parse(raw.toString());
      for (const msg of Array.isArray(msgs) ? msgs : [msgs]) {
        if (msg.type === 'ready') {
          metrics.readyAt = Date.now() - start;
          ws.send(JSON.stringify({ type: 'chat', text: PROMPT }));
        } else if (msg.type === 'delta') {
          if (!metrics.firstDeltaAt) metrics.firstDeltaAt = Date.now() - start;
          metrics.text += msg.text || '';
        } else if (msg.type === 'done') {
          metrics.doneAt = Date.now() - start;
          finish('done');
        } else if (msg.type === 'error') {
          finish('error', msg.message);
        }
      }
    });

    ws.on('error', (err) => finish('ws-error', err.message));
    ws.on('close', () => { if (!finished) finish('closed-early'); });
  });
}

async function main() {
  fs.writeFileSync(LOGFILE, `[${now()}] Concurrency limit test: CONCURRENCY=${CONCURRENCY}\n`);
  log(`Launching ${CONCURRENCY} concurrent chats...`);
  const startAll = Date.now();
  const promises = [];
  for (let i = 1; i <= CONCURRENCY; i++) {
    promises.push(runOne(i));
  }
  const results = await Promise.all(promises);
  const total = Date.now() - startAll;

  const succeeded = results.filter(r => r.reason === 'done' && !r.error).length;
  const failed = CONCURRENCY - succeeded;
  const readyTimes = results.filter(r => r.readyAt != null).map(r => r.readyAt);
  const ttftTimes = results.filter(r => r.firstDeltaAt != null).map(r => r.firstDeltaAt);
  const doneTimes = results.filter(r => r.doneAt != null).map(r => r.doneAt);

  log(`=== Results CONCURRENCY=${CONCURRENCY} ===`);
  log(`total wall time: ${total}ms`);
  log(`success: ${succeeded}/${CONCURRENCY}, failed: ${failed}/${CONCURRENCY}`);
  if (readyTimes.length) log(`ready: min=${Math.min(...readyTimes)}ms max=${Math.max(...readyTimes)}ms avg=${Math.round(readyTimes.reduce((a,b)=>a+b)/readyTimes.length)}ms`);
  if (ttftTimes.length) log(`ttft:  min=${Math.min(...ttftTimes)}ms max=${Math.max(...ttftTimes)}ms avg=${Math.round(ttftTimes.reduce((a,b)=>a+b)/ttftTimes.length)}ms`);
  if (doneTimes.length) log(`done:  min=${Math.min(...doneTimes)}ms max=${Math.max(...doneTimes)}ms avg=${Math.round(doneTimes.reduce((a,b)=>a+b)/doneTimes.length)}ms`);

  for (const r of results) {
    if (r.error || r.reason !== 'done' || !r.doneAt) {
      log(`[${r.id}] FAIL reason=${r.reason} error="${r.error || ''}" ready=${r.readyAt} ttft=${r.firstDeltaAt} done=${r.doneAt} chars=${r.text.length}`);
    } else {
      log(`[${r.id}] OK ready=${r.readyAt}ms ttft=${r.firstDeltaAt}ms done=${r.doneAt}ms chars=${r.text.length}`);
    }
  }
}

main().catch(e => { log('FATAL', e.message); process.exit(1); });
