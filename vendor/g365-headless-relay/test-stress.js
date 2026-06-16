const WebSocket = require('ws');

const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:8765';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '3', 10);
const PROMPT = process.env.PROMPT || 'Say hello and confirm which Copilot model you are, briefly.';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function runChat(id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const start = Date.now();
    const metrics = { id, start, connectedAt: null, readyAt: null, firstDeltaAt: null, doneAt: null, text: '', error: null };
    let done = false;

    ws.on('open', () => {
      metrics.connectedAt = Date.now();
      ws.send(JSON.stringify({ type: 'new', model: 'gpt-5.5-think-deeper' }));
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ready') {
        metrics.readyAt = Date.now();
        ws.send(JSON.stringify({ type: 'chat', text: `[${id}] ${PROMPT}` }));
      }
      if (msg.type === 'delta') {
        if (!metrics.firstDeltaAt) metrics.firstDeltaAt = Date.now();
        metrics.text += msg.text;
      }
      if (msg.type === 'message') metrics.text += msg.text || '';
      if (msg.type === 'done') {
        if (done) return;
        done = true;
        metrics.doneAt = Date.now();
        ws.close();
        resolve(metrics);
      }
      if (msg.type === 'error') {
        metrics.error = msg.message;
      }
    });

    ws.on('error', (err) => {
      metrics.error = err.message;
      reject(metrics);
    });

    setTimeout(() => {
      if (!done) {
        metrics.error = 'Test timed out after 90s';
        ws.close();
        resolve(metrics);
      }
    }, 90000);
  });
}

async function main() {
  console.log(`\nStress test: ${CONCURRENCY} concurrent warm chats\n`);
  const results = await Promise.allSettled(Array.from({ length: CONCURRENCY }, (_, i) => runChat(i + 1)));

  console.log('\n=== Results ===\n');
  let success = 0, fail = 0;
  for (const r of results) {
    const m = r.status === 'fulfilled' ? r.value : r.reason;
    const ok = m.doneAt && !m.error;
    if (ok) success++; else fail++;
    console.log(`Chat ${m.id}: ${ok ? '✅' : '❌'} ${m.error || ''}`);
    if (m.connectedAt) console.log(`  connect: ${m.connectedAt - (m.start || 0)}ms`);
    if (m.readyAt && m.connectedAt) console.log(`  ready:   ${m.readyAt - m.connectedAt}ms`);
    if (m.firstDeltaAt && m.readyAt) console.log(`  ttft:    ${m.firstDeltaAt - m.readyAt}ms`);
    if (m.doneAt && m.firstDeltaAt) console.log(`  total:   ${m.doneAt - m.firstDeltaAt}ms`);
    console.log(`  text:    ${m.text.trim().slice(0, 120).replace(/\n/g, ' ')}`);
    console.log();
  }
  console.log(`Success: ${success}/${CONCURRENCY}, Failed: ${fail}/${CONCURRENCY}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
