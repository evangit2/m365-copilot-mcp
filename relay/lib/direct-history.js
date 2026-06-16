const { DirectChat } = require('./direct-chat');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const SIGNALR_SEP = '\x1e';

/**
 * Minimal history fetcher for the M365 Copilot substrate SignalR hub.
 *
 * It sends a `getConversations` invocation on the same WebSocket template
 * used for chat.  If the server responds with a type-2 stream item whose
 * `item`/`arguments` contain a conversation list, we parse it.
 *
 * This is reverse-engineered: M365 does not document a public history
 * method on this hub, but the chat protocol exposes conversation metadata
 * after a `chat` invocation and some clients request it via `getConversations`
 * or `getRecentConversations`.  We try the most common target names.
 */
class DirectHistory {
  constructor({ templateUrl }) {
    this.templateUrl = templateUrl;
    this.sessionId = uuidv4();
    this.reqId = uuidv4();
  }

  _buildWsUrl() {
    const u = new URL(this.templateUrl);
    u.searchParams.set('ClientRequestId', this.reqId);
    u.searchParams.set('X-SessionId', this.sessionId);
    // ConversationId can be empty/omitted for list requests; use a placeholder
    u.searchParams.set('ConversationId', '00000000-0000-0000-0000-000000000000');
    return u.toString();
  }

  _invokeFrame(target, args = []) {
    return JSON.stringify({
      arguments: args,
      invocationId: '0',
      target,
      type: 4,
    }) + SIGNALR_SEP;
  }

  /**
   * Try to fetch conversation history.
   * @returns {Promise<Array<{id, title, date, messages?}>>}
   */
  async getHistory(timeoutMs = 30000) {
    const url = this._buildWsUrl();
    const ws = new WebSocket(url, { origin: 'https://m365.cloud.microsoft' });

    return new Promise((resolve, reject) => {
      let done = false;
      let handshakeDone = false;
      const results = [];

      const finish = (val) => {
        if (done) return;
        done = true;
        try { ws.close(); } catch (e) {}
        resolve(val);
      };
      const fail = (err) => {
        if (done) return;
        done = true;
        try { ws.close(); } catch (e) {}
        reject(err);
      };

      const timer = setTimeout(() => fail(new Error('History request timeout')), timeoutMs);

      ws.on('open', () => {
        ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + SIGNALR_SEP);
      });

      ws.on('message', (data) => {
        const raw = data.toString();
        const parts = raw.split(SIGNALR_SEP);
        for (const part of parts) {
          if (!part.trim()) continue;
          if (!handshakeDone) {
            handshakeDone = true;
            // Try common history method names.  M365 may ignore unknown targets.
            ws.send(this._invokeFrame('getConversations', [{
              source: 'officeweb',
              clientCorrelationId: this.reqId,
              sessionId: this.sessionId,
              clientInfo: {
                clientPlatform: 'mcmcopilot-web', clientAppName: 'Office',
                clientEntrypoint: 'mcmcopilot-officeweb', clientSessionId: this.sessionId,
                clientAppType: 'Web', deviceOS: 'Windows', deviceType: 'Desktop',
                ProductCategory: 'Chat', productEntryPoint: 'ChatPanel',
              },
            }]));
            continue;
          }

          let msg;
          try { msg = JSON.parse(part); } catch (e) { continue; }

          const t = msg.type;
          if (t === 6) continue; // ping
          if (t === 3) {
            clearTimeout(timer);
            return finish(results);
          }

          // Attempt to extract a conversation list from various shapes M365 may return.
          if (t === 2 || t === 1) {
            const candidates = [];
            if (msg.item) candidates.push(msg.item);
            if (msg.arguments && Array.isArray(msg.arguments)) {
              for (const a of msg.arguments) if (a) candidates.push(a);
            }

            for (const c of candidates) {
              const arr = c.conversations || c.chats || c.items || c.messages || (Array.isArray(c) ? c : null);
              if (arr && Array.isArray(arr)) {
                for (const conv of arr) {
                  const id = conv.conversationId || conv.id || conv.chatId || uuidv4();
                  const title = conv.title || conv.displayName || conv.topic || conv.name || '(untitled)';
                  const date = conv.updatedDateTime || conv.createdDateTime || conv.lastUpdated || conv.timestamp || null;
                  results.push({ id, title, date });
                }
              }
            }
          }
        }
      });

      ws.on('error', (err) => fail(new Error('History WS error: ' + err.message)));
      ws.on('close', () => {
        if (!done) finish(results);
      });
    });
  }
}

module.exports = { DirectHistory };
