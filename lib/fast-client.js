const WebSocket = require('ws');

const RELAY_WS_URL = process.env.RELAY_WS_URL || 'ws://127.0.0.1:8765';

function toneForModel(model) {
  const m = String(model || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (m.includes('reasoning') || m.includes('thinkdeeper') || m.includes('thinkdeep')) return 'Gpt_5_5_Reasoning';
  if (m.includes('quick') || m.includes('chat')) return 'Gpt_5_5_Chat';
  return 'Gpt_5_5_Reasoning';
}

function relayChat(prompt, { model = 'gpt-5.5-think-deeper', maxWaitMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_WS_URL);
    const tone = toneForModel(model);
    let startedAt = null;
    let firstAt = null;
    let done = false;
    let finalText = '';
    let reasoningText = '';

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

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'new', model: 'gpt-5.5-think-deeper', tone }));
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
        // The relay sends cursor deltas and full-message snapshots. Keep the
        // longest final-looking snapshot; ignore tiny/duplicate deltas.
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
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { ws.close(); } catch (e) {}
        reject(new Error(msg.error || msg.message || 'Relay chat error'));
      }
    });

    ws.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error('Relay WebSocket error: ' + err.message));
    });

    ws.on('close', () => {
      finish();
    });
  });
}

module.exports = { relayChat, toneForModel };
