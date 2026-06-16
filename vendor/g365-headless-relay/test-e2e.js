const WebSocket = require('ws');

const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:8765';
const PROMPT = process.env.PROMPT || 'Say hello and confirm which Copilot model you are.';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function test() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const start = Date.now();
    let connectedAt, readyAt, sentAt, firstDeltaAt;
    let fullText = '';
    let done = false;

    ws.on('open', () => {
      connectedAt = Date.now();
      console.log(`[test] connected in ${connectedAt - start}ms`);
      ws.send(JSON.stringify({ type: 'new', model: 'gpt-5.5-think-deeper' }));
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ready') {
        readyAt = Date.now();
        console.log(`[test] ready in ${readyAt - start}ms (model: ${msg.model || 'default'})`);
        sentAt = Date.now();
        ws.send(JSON.stringify({ type: 'chat', text: PROMPT }));
      }
      if (msg.type === 'delta') {
        if (!firstDeltaAt) {
          firstDeltaAt = Date.now();
          console.log(`[test] first delta in ${firstDeltaAt - sentAt}ms`);
        }
        process.stdout.write(msg.text);
        fullText += msg.text;
      }
      if (msg.type === 'message') {
        fullText += msg.text || '';
      }
      if (msg.type === 'done') {
        console.log(`\n[test] done in ${Date.now() - start}ms`);
        ws.close();
        resolve(fullText);
      }
      if (msg.type === 'error') {
        console.log(`[test] error: ${msg.message}`);
        ws.close();
        reject(new Error(msg.message));
      }
    });

    ws.on('error', reject);

    setTimeout(() => {
      if (!done) {
        ws.close();
        reject(new Error('Test timed out after 90s'));
      }
    }, 90000);
  });
}

test()
  .then(text => {
    console.log('\n--- Full response ---');
    console.log(text.trim());
    if (!/gpt-5|gpt 5|think deeper|reasoning/i.test(text)) {
      console.error('⚠️ Response does not mention GPT 5.5 Think Deeper');
      process.exit(1);
    }
    console.log('✅ GPT 5.5 Think Deeper confirmed');
    process.exit(0);
  })
  .catch(err => {
    console.error('\n❌ Test failed:', err.message);
    process.exit(1);
  });
