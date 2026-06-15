const http = require('http');
const { URL } = require('url');

/**
 * Minimal OpenAI-compatible client for the g365-headless-relay HTTP API.
 */
class RelayClient {
  constructor({ baseUrl = 'http://127.0.0.1:9000', apiKey = null, timeoutMs = 180000 }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  _request(path, { method = 'GET', body = null, retries = 2 } = {}) {
    return new Promise((resolve, reject) => {
      const attempt = (remaining, delayMs) => {
        const url = new URL(path, this.baseUrl);
        const headers = {
          'Content-Type': 'application/json',
        };
        if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

        const data = body ? JSON.stringify(body) : null;
        if (data) headers['Content-Length'] = Buffer.byteLength(data);

        const controller = new AbortController();
        const req = http.request({
          hostname: url.hostname,
          port: url.port || 80,
          path: url.pathname + url.search,
          method,
          headers,
          signal: controller.signal,
        }, (res) => {
          let buf = '';
          res.on('data', chunk => buf += chunk);
          res.on('end', () => {
            try {
              const parsed = JSON.parse(buf);
              if (res.statusCode >= 400) {
                const msg = parsed.error?.message || `HTTP ${res.statusCode}`;
                const err = new Error(msg);
                err.statusCode = res.statusCode;
                err.body = parsed;
                err.retryable = (res.statusCode === 429 || res.statusCode >= 500);
                // Retry on 429 / 5xx if we have attempts left
                if (remaining > 0 && err.retryable) {
                  setTimeout(() => attempt(remaining - 1, delayMs * 2), delayMs);
                  return;
                }
                reject(err);
              } else {
                resolve(parsed);
              }
            } catch (e) {
              const err = new Error(`Non-JSON response: ${buf.slice(0, 200)}`);
              err.statusCode = res.statusCode;
              reject(err);
            }
          });
        });

        const timer = setTimeout(() => {
          controller.abort();
          const err = new Error('Relay request timed out');
          err.retryable = true;
          if (remaining > 0) {
            setTimeout(() => attempt(remaining - 1, delayMs * 2), delayMs);
          } else {
            reject(err);
          }
        }, this.timeoutMs);

        req.on('error', (e) => {
          clearTimeout(timer);
          const err = new Error(`Relay connection error: ${e.message}`);
          err.retryable = true;
          if (remaining > 0) {
            setTimeout(() => attempt(remaining - 1, delayMs * 2), delayMs);
          } else {
            reject(err);
          }
        });

        req.on('abort', () => {
          clearTimeout(timer);
        });

        if (data) req.write(data);
        req.end();
      };
      attempt(retries, 1500);
    });
  }

  async health() {
    return this._request('/health');
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
    // The relay may wrap reasoning in  thinking tags. Strip by default.
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

module.exports = { RelayClient };
