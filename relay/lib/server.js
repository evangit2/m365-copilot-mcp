const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const BRIDGE_PATH = path.join(__dirname, 'bridge.js');
const { DirectChat } = require('./direct-chat');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function createServer(args) {
  const port = args.relayPort || 8765;
  const wss = new WebSocket.Server({ port });
  const bridgeSrc = fs.readFileSync(BRIDGE_PATH, 'utf-8');
  const ctx = args.ctx;
  const POOL_SIZE = args.poolSize || 1;

  // Shared state with index.js so the OpenAI HTTP server can read template URL
  const sharedState = args.sharedState || {};

  let clientId = 0;
  const clients = new Map();
  let cachedTemplateUrl = sharedState.cachedTemplateUrl || null;  // captured from any warmed page

  console.log('\n═══════════════════════════════════════');
  console.log('  G365 M365 Copilot Relay');
  console.log('  ws://127.0.0.1:' + port);
  console.log('  Default: GPT 5.5 Think Deeper');
  console.log('  Page pool size: ' + POOL_SIZE);
  console.log('  Direct API mode: enabled');
  console.log('═══════════════════════════════════════\n');

  // ── Page pool ────────────────────────────────────────────
  // Single browser context can only warm one page at a time reliably.
  // We keep POOL_SIZE idle warmed pages and a FIFO queue for bursts.

  const pagePool = [];         // idle warmed pages
  const waitQueue = [];        // { resolve, reject, timer }
  let poolDraining = false;
  let warmWorkerRunning = false;
  let poolReadyResolve = null;
  const poolReadyPromise = new Promise(r => { poolReadyResolve = r; });

  async function findAndClickInput(page) {
    const selectors = [
      '[contenteditable="true"]','textarea','[role="textbox"]',
      '#userInput','[data-testid="chat-input"]','.chat-input',
      '[placeholder*="Ask" i]','[placeholder*="Message" i]'
    ];
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) { await el.click().catch(() => {}); return true; }
      } catch (e) {}
    }
    return false;
  }

  async function warmPage() {
    if (!ctx || poolDraining) return null;
    const start = Date.now();
    try {
      const page = await ctx.newPage();
      page.on('console', (msg) => {
        const text = msg.text();
        if (text.includes('[COPILOT]')) console.log(`[pool] ${text}`);
      });
      await page.addInitScript(bridgeSrc);

      await page.goto('https://m365.cloud.microsoft/chat?auth=2', {
        waitUntil: 'networkidle',
        timeout: 60000,
      }).catch(() => {});
      await sleep(2000);

      const url = page.url();
      if (url.includes('login.microsoftonline.com')) {
        console.log(`[pool] Auth expired — redirect to Microsoft login`);
        try { await page.close(); } catch(e) {}
        return null;
      }

      let ready = false;
      for (let i = 0; i < 45; i++) {
        await sleep(1000);
        try {
          ready = await page.evaluate(() => !!(window.__m365Ready && window.__m365Ready()));
          if (ready) break;
        } catch (e) {}
        if (i % 5 === 0) {
          await findAndClickInput(page);
          try { await page.keyboard.type(' ', { delay: 5 }); } catch (e) {}
          await sleep(500);
          try { await page.keyboard.press('Escape'); } catch (e) {}
        }
      }

      if (!ready) {
        console.log(`[pool] Page failed to warm after ${Date.now()-start}ms`);
        try { await page.close(); } catch(e) {}
        return null;
      }

      await page.evaluate(() => {
        if (window.__m365SetModel) window.__m365SetModel('gpt-5.5-think-deeper');
      });
      await findAndClickInput(page);
      await sleep(300);
      await page.keyboard.press('Escape').catch(()=>{});

      console.log(`[pool] Page warmed in ${Date.now()-start}ms`);
      try {
        const template = await page.evaluate(() => {
          if (window.__m365Ready && window.__m365Ready()) {
            // Bridge stores template in closure var; expose via a new global
            return window.__m365CapturedUrl || null;
          }
          return null;
        });
        if (template) {
          cachedTemplateUrl = template;
          sharedState.cachedTemplateUrl = template;
          console.log(`[pool] Captured direct API template`);
        }
      } catch(e) {}
      return page;
    } catch (e) {
      console.log(`[pool] Warm error: ${e.message}`);
      return null;
    }
  }

  // Single worker: warm pages one at a time. Prefer giving them to waiting
  // clients; only add to the idle pool when no one is waiting.
  async function warmWorker() {
    if (warmWorkerRunning) return;
    warmWorkerRunning = true;
    try {
      while (true) {
        if (poolDraining) break;

        // Stop if idle pool is full and no one is waiting
        if (pagePool.length >= POOL_SIZE && waitQueue.length === 0) break;

        const page = await warmPage();
        if (!page) break;

        if (waitQueue.length > 0) {
          const { resolve, timer } = waitQueue.shift();
          clearTimeout(timer);
          resolve(page);
        } else {
          pagePool.push(page);
        }
      }

      if (poolReadyResolve) { poolReadyResolve(); poolReadyResolve = null; }
    } finally {
      warmWorkerRunning = false;
    }
  }

  async function takePage() {
    // Fast path: idle warmed page available
    if (pagePool.length > 0) return pagePool.shift();

    // Need to wait for a page. Queue up.
    console.log('[pool] No idle page — client queued');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waitQueue.findIndex(q => q.reject === reject);
        if (idx >= 0) waitQueue.splice(idx, 1);
        reject(new Error('Timed out waiting for a warmed page'));
      }, 120000);
      waitQueue.push({ resolve, reject, timer });
      warmWorker();
    });
  }

  function returnPage(page) {
    if (!page) return;
    if (waitQueue.length > 0) {
      const { resolve, timer } = waitQueue.shift();
      clearTimeout(timer);
      resolve(page);
      return;
    }
    pagePool.push(page);
    // Trim idle pool back to POOL_SIZE
    while (pagePool.length > POOL_SIZE) {
      const extra = pagePool.pop();
      try { extra.close().catch(()=>{}); } catch(e){}
    }
  }
  // Start warming the pool as soon as the browser context is ready
  if (ctx) {
    setTimeout(() => warmWorker(), 100);
  }

  // Expose a helper so HTTP server can wait for template readiness
  function getTemplateUrl() { return cachedTemplateUrl; }
  args.getTemplateUrl = getTemplateUrl;

  // ── WebSocket handling ─────────────────────────────────────

  wss.on('connection', async function(clientWs, req) {
    const cid = ++clientId;
    const client = { ws: clientWs, page: null, directChat: null, closed: false, model: 'gpt-5.5-think-deeper', ready: false, directMode: false };
    clients.set(cid, client);

    console.log(`[${cid}] + Connected from ${req.socket.remoteAddress || 'local'}`);

    if (!ctx) {
      send({ type: 'error', message: 'Browser not ready. Restart relay.' });
      clientWs.close();
      return;
    }

    let pollTimer = null;
    let heartbeatTimer = null;
    let lastPing = Date.now();
    const earlyMessages = [];
    let messageHandlerReady = false;

    function send(obj) {
      if (!client.closed && clientWs.readyState === WebSocket.OPEN) {
        try { clientWs.send(JSON.stringify(obj)); }
        catch (e) { console.log(`[${cid}] Send error: ${e.message}`); }
      }
    }

    function cleanup(reason) {
      if (client.closed) return;
      client.closed = true;
      console.log(`[${cid}] Closed${reason ? ' (' + reason + ')' : ''}`);
      if (pollTimer) clearInterval(pollTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (client.page) {
        returnPage(client.page);
        client.page = null;
      }
      clients.delete(cid);
    }

    clientWs.on('close', (code, reason) => cleanup(`client disconnected, code=${code}`));
    clientWs.on('error', (err) => {
      console.log(`[${cid}] WS error: ${err.message}`);
      cleanup('ws error');
    });

    async function setupDirectChat(templateUrl) {
      const dc = new DirectChat({ templateUrl, tone: client.model === 'gpt-5.5-quick' ? 'Gpt_5_5_Chat' : 'Gpt_5_5_Reasoning' });
      dc.onDelta = (delta) => {
        if (typeof delta === 'object' && delta.type === 'message') {
          send({ type: 'message', text: delta.text, turnState: delta.turnState });
        } else {
          send({ type: 'delta', text: delta });
        }
      };
      dc.onReasoningDelta = (text) => send({ type: 'reasoning_delta', text });
      dc.onDone = () => send({ type: 'done' });
      dc.onError = (err) => send({ type: 'error', message: err });
      client.directChat = dc;
      client.directMode = true;
    }

    async function handleMessage(raw) {
      if (client.closed) return;
      lastPing = Date.now();

      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) {
        return send({ type: 'error', message: 'Invalid JSON' });
      }

      switch (msg.type) {
        case 'new':
          client.model = msg.model || 'gpt-5.5-think-deeper';

          // Prefer direct API mode if we have a captured template URL
          if (cachedTemplateUrl || (client.page && await client.page.evaluate(() => window.__m365CapturedUrl || null))) {
            const tpl = cachedTemplateUrl || await client.page.evaluate(() => window.__m365CapturedUrl || null);
            if (tpl) {
              cachedTemplateUrl = tpl;
              sharedState.cachedTemplateUrl = tpl;
            }
            await setupDirectChat(tpl);
            client.ready = true;
            send({ type: 'ready', model: client.model, mode: 'direct' });
            console.log(`[${cid}] Direct chat ready (${client.model})`);
          } else {
            // Fallback to browser bridge
            if (client.page) {
              try { await client.page.evaluate((m) => { if (window.__m365SetModel) window.__m365SetModel(m); }, client.model); } catch (e) {}
              try { await client.page.evaluate(() => { if (window.__m365ClearConversation) window.__m365ClearConversation(); }); } catch (e) {}
            }
            client.ready = true;
            send({ type: 'ready', model: client.model, mode: 'browser' });
            console.log(`[${cid}] Browser bridge ready (${client.model})`);
          }
          break;

        case 'chat': {
          const text = msg.text || msg.message;
          if (!text) return send({ type: 'error', message: 'text or message required' });
          console.log(`[${cid}] User: ${text.substring(0, 80)}${text.length > 80 ? '...' : ''}`);
          if (!client.ready) return send({ type: 'error', message: 'Not ready yet.' });

          if (client.directMode && client.directChat) {
            client.directChat.send(text);
          } else if (client.page) {
            try {
              if (!client.page || client.page.isClosed()) {
                const fresh = await takePage();
                if (!fresh) { send({ type: 'error', message: 'Page unavailable.' }); break; }
                client.page = fresh;
              }
              await client.page.evaluate((t) => { if (window.__m365Send) window.__m365Send(t, { newConversation: false }); }, text);
            } catch (e) {
              console.error(`[${cid}] Send error: ${e.message}`);
              send({ type: 'error', message: e.message });
            }
          } else {
            send({ type: 'error', message: 'No chat transport available.' });
          }
          break;
        }

        case 'ping':
          send({ type: 'pong', timestamp: Date.now() });
          break;

        case 'clear':
          if (client.directMode && client.directChat) {
            client.directChat.clear();
            send({ type: 'cleared' });
          } else if (client.page) {
            try {
              await client.page.evaluate(() => { if (window.__m365ClearConversation) window.__m365ClearConversation(); });
              send({ type: 'cleared' });
            } catch (e) { send({ type: 'error', message: e.message }); }
          }
          break;

        case 'status':
          if (client.directMode && client.directChat) {
            send({ type: 'status', streaming: client.directChat.isStreaming, model: client.model, mode: 'direct' });
          } else if (client.page) {
            try {
              const streaming = await client.page.evaluate(() => window.__m365IsStreaming ? window.__m365IsStreaming() : false);
              send({ type: 'status', streaming, model: client.model, mode: 'browser' });
            } catch (e) { send({ type: 'error', message: e.message }); }
          }
          break;

        default:
          send({ type: 'error', message: 'Unknown type: ' + msg.type });
      }
    }

    // Attach message handler early so we don't miss the client's 'new' message
    // while we're acquiring a warmed page.
    clientWs.on('message', (raw) => {
      lastPing = Date.now();
      if (!messageHandlerReady) {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
        earlyMessages.push(msg);
        return;
      }
      handleMessage(raw).catch(err => console.log(`[${cid}] Message handler error: ${err.message}`));
    });

    // Heartbeat - check connection health + send WS ping frames
    heartbeatTimer = setInterval(() => {
      if (client.closed) return;
      if (Date.now() - lastPing > 120000) {
        console.log(`[${cid}] Heartbeat timeout`);
        send({ type: 'error', message: 'Connection idle timeout' });
        cleanup('idle timeout');
        return;
      }
      // Send native WS ping frame
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.ping();
      }
    }, 15000);

    // ── Take a pre-warmed page ──
    // Prefer direct API if we already captured a template URL
    if (cachedTemplateUrl) {
      try {
        await setupDirectChat(cachedTemplateUrl);
      } catch (e) {
        console.log(`[${cid}] Direct chat setup failed: ${e.message}`);
        send({ type: 'error', message: 'Direct chat setup failed: ' + e.message });
        cleanup('direct setup failed');
        return;
      }
      messageHandlerReady = true;
      for (const msg of earlyMessages) {
        handleMessage(JSON.stringify(msg)).catch(err => console.log(`[${cid}] Early msg error: ${err.message}`));
      }
      console.log(`[${cid}] Ready (${client.model}) — direct`);
      client.ready = true;
      send({ type: 'ready', model: client.model, mode: 'direct' });
      return;
    }

    // No template yet: wait for the single warmed page, capture its template, then switch to direct mode.
    await poolReadyPromise;
    let page = null;
    try {
      page = await takePage();
    } catch (e) {
      send({ type: 'error', code: 'TIMEOUT', message: 'No warmed pages available. Try again in a few seconds.' });
      cleanup('no page');
      return;
    }

    if (!page) {
      send({ type: 'error', code: 'TIMEOUT', message: 'No warmed pages available. Try again in a few seconds.' });
      cleanup('no page');
      return;
    }

    client.page = page;

    const stillReady = await page.evaluate(() => !!(window.__m365Ready && window.__m365Ready()));
    if (!stillReady) {
      console.log(`[${cid}] Page lost readiness — warming fresh`);
      returnPage(page);
      const freshPage = await warmPage();
      if (!freshPage) {
        send({ type: 'error', code: 'TIMEOUT', message: 'Failed to prepare page. Try again.' });
        cleanup('fresh warm failed');
        return;
      }
      client.page = freshPage;
    }

    // Try to extract template from the page; if we get it, switch this client to direct mode immediately.
    if (client.page) {
      try {
        const tpl = await client.page.evaluate(() => window.__m365CapturedUrl || null);
        if (tpl) {
          cachedTemplateUrl = tpl;
          sharedState.cachedTemplateUrl = tpl;
          console.log(`[${cid}] Captured template from page, switching to direct mode`);
          returnPage(client.page);
          client.page = null;
          await setupDirectChat(tpl);
          messageHandlerReady = true;
          for (const msg of earlyMessages) {
            handleMessage(JSON.stringify(msg)).catch(err => console.log(`[${cid}] Early msg error: ${err.message}`));
          }
          client.ready = true;
          send({ type: 'ready', model: client.model, mode: 'direct' });
          return;
        }
      } catch (e) {}
    }

    try { await client.page.evaluate(() => { if (window.__m365ClearConversation) window.__m365ClearConversation(); }); } catch (e) {}
    try { await client.page.evaluate((m) => { if (window.__m365SetModel) window.__m365SetModel(m); }, client.model); } catch (e) {}

    console.log(`[${cid}] Ready (${client.model}) — from pool (browser mode)`);
    client.ready = true;

    clientWs.isAlive = true;
    clientWs.on('pong', () => { clientWs.isAlive = true; });

    pollTimer = setInterval(async () => {
      if (client.closed || !client.page || client.page.isClosed()) return;
      try {
        const items = await client.page.evaluate(() => window.__m365Poll ? window.__m365Poll() : []);
        if (!items || !items.length) return;
        for (const item of items) {
          if (client.closed) return;
          if (item.type === 'error') console.log(`[${cid}] Bridge error: ${item.message}`);
          send(item);
        }
      } catch (e) {
        if (!client.closed) console.log(`[${cid}] Poll error: ${e.message}`);
      }
    }, 25);

    messageHandlerReady = true;
    for (const msg of earlyMessages) {
      handleMessage(JSON.stringify(msg)).catch(err => console.log(`[${cid}] Early message handler error: ${err.message}`));
    }
  });
  return { wss, drain: () => { poolDraining = true; pagePool.forEach(p => p.close().catch(()=>{})); waitQueue.forEach(q => { clearTimeout(q.timer); q.reject(new Error("Pool draining")); }); } };
}

module.exports = { createServer };
