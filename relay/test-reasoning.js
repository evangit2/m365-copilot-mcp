const WebSocket = require('ws');
const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:8765';

const PROMPT = 'Show your reasoning step by step: is 104729 a prime number? Give the final answer at the end.';
const ws = new WebSocket(WS_URL);

let ready = false;
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'new', model: 'gpt-5.5-think-deeper' }));
});

ws.on('message', (raw) => {
  const msgs = JSON.parse(raw.toString());
  for (const msg of Array.isArray(msgs) ? msgs : [msgs]) {
    if (msg.type === 'ready') {
      ready = true;
      ws.send(JSON.stringify({ type: 'chat', text: PROMPT }));
    } else if (msg.type === 'reasoning_delta') {
      process.stdout.write(msg.text);
    } else if (msg.type === 'delta') {
      process.stdout.write(msg.text);
    } else if (msg.type === 'done') {
      console.log('\n\n[done]');
      ws.close();
      process.exit(0);
    } else if (msg.type === 'error') {
      console.error('\n[error]', msg.message);
      ws.close();
      process.exit(1);
    }
  }
});

ws.on('error', (e) => { console.error('ws error', e.message); process.exit(1); });
