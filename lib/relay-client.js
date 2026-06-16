const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * Minimal OpenAI-compatible client for the g365-headless-relay HTTP API.
 */
class RelayClient {
  constructor({ baseUrl = 'http://127.0.0.1:9000', apiKey = null, timeoutMs = 180000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  _request(path, { method = 'GET', body = null, retries = 2 } = {}) {
    return new Promise((resolve, reject) => {
      const attempt = (remaining, delayMs) => {
        const url = new URL(path, this.baseUrl);
        const transport = url.protocol === 'https:' ? https : http;
        const headers = {
          'Content-Type': 'application/json',
        };
        if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

        const data = body ? JSON.stringify(body) : null;
        if (data) headers['Content-Length'] = Buffer.byteLength(data);

        let settled = false;
        let timer = null;

        const cleanup = () => {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
        };

        const retryOrReject = (err) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (remaining > 0 && err.retryable) {
            setTimeout(() => attempt(remaining - 1, delayMs * 2), delayMs);
          } else {
            reject(err);
          }
        };

        const resolveOnce = (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };

        const req = transport.request(url, {
          method,
          headers,
        }, (res) => {
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', chunk => { buf += chunk; });
          res.on('end', () => {
            let parsed = null;
            if (buf.trim().length > 0) {
              try {
                parsed = JSON.parse(buf);
              } catch (e) {
                const err = new Error(`Non-JSON response from relay (HTTP ${res.statusCode}): ${buf.slice(0, 200)}`);
                err.statusCode = res.statusCode;
                err.retryable = res.statusCode >= 500;
                retryOrReject(err);
                return;
              }
            } else {
              parsed = {};
            }

            if (res.statusCode >= 400) {
              const err = buildRelayError(res.statusCode, parsed);
              retryOrReject(err);
              return;
            }

            resolveOnce(parsed);
          });
        });

        timer = setTimeout(() => {
          const err = new Error(`Relay request timed out after ${this.timeoutMs}ms`);
          err.code = 'RELAY_TIMEOUT';
          err.retryable = true;
          req.destroy(err);
          retryOrReject(err);
        }, this.timeoutMs);

        req.on('error', (e) => {
          if (e && e.code === 'RELAY_TIMEOUT') {
            retryOrReject(e);
            return;
          }
          const err = new Error(`Relay connection error: ${e.message}`);
          err.code = e.code;
          err.retryable = true;
          retryOrReject(err);
        });

        if (data) req.write(data);
        req.end();
      };

      attempt(retries, 1500);
    });
  }

  async health() {
    return this._request('/health', { retries: 0 });
  }

  async models() {
    return this._request('/v1/models');
  }

  async history() {
    return this._request('/v1/conversations');
  }

  /**
   * Send a synchronous chat completion.
   * @param {string} prompt
   * @param {object} options
   * @returns {Promise<{content: string, reasoning: string, raw: object}>}
   */
  async chat(prompt, options = {}) {
    const model = options.model || process.env.M365_MODEL || 'gpt-5.5-think-deeper';
    const maxTokens = options.max_tokens || 4000;
    const temperature = options.temperature ?? 0.2;
    const includeReasoning = options.include_reasoning === true || process.env.MCP_SHOW_REASONING === '1';

    const res = await this._request('/v1/chat/completions', {
      method: 'POST',
      body: {
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        max_tokens: maxTokens,
        temperature,
      },
    });

    const choice = res.choices?.[0];
    const content = choice?.message?.content || '';
    // The relay may wrap reasoning in escaped <think> tags. Strip by default.
    let reasoning = '';
    let finalContent = content;
    const thinkMatch = content.match(/\u003cthink\u003e([\s\S]*?)\u003c\/think\u003e/i);
    if (thinkMatch) {
      reasoning = thinkMatch[1].trim();
      finalContent = content.replace(/\u003cthink\u003e[\s\S]*?\u003c\/think\u003e\s*/i, '').trim();
    }

    return {
      content: finalContent,
      reasoning: includeReasoning ? reasoning : '',
      raw: res,
    };
  }
}

function buildRelayError(statusCode, parsed) {
  const relayError = parsed?.error || {};
  const rawMessage = relayError.message || parsed?.message || `HTTP ${statusCode}`;
  const message = String(rawMessage);
  const err = new Error(message);
  err.statusCode = statusCode;
  err.body = parsed;
  err.relayType = relayError.type;

  if (isRateLimitMessage(statusCode, message)) {
    err.code = 'M365_RATE_LIMIT';
    err.message = `${message} (M365 Copilot rate limit hit; wait before retrying.)`;
    err.retryable = false;
    return err;
  }

  if (isAuthExpiredMessage(statusCode, message)) {
    err.code = 'M365_AUTH_EXPIRED';
    err.message = `${message} (M365 auth/session appears stale: the relay health check can still be green while its captured Substrate token is expired. Re-authenticate or restart/warm g365-headless-relay.)`;
    err.retryable = false;
    return err;
  }

  err.retryable = statusCode >= 500;
  return err;
}

function isAuthExpiredMessage(statusCode, message) {
  return statusCode === 401 ||
    /unexpected server response:\s*401/i.test(message) ||
    /\bunauthori[sz]ed\b/i.test(message) ||
    /auth(?:entication)? (?:expired|failed)/i.test(message) ||
    /token (?:expired|invalid|stale)/i.test(message);
}

function isRateLimitMessage(statusCode, message) {
  return statusCode === 429 ||
    /reached the limit/i.test(message) ||
    /rate.?limit/i.test(message) ||
    /too many requests/i.test(message);
}

module.exports = {
  RelayClient,
  buildRelayError,
  isAuthExpiredMessage,
  isRateLimitMessage,
};
