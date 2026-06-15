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

  _request(path, { method = 'GET', body = null } = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const headers = {
        'Content-Type': 'application/json',
      };
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

      const data = body ? JSON.stringify(body) : null;
      if (data) headers['Content-Length'] = Buffer.byteLength(data);

      const req = http.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method,
        headers,
        timeout: this.timeoutMs,
      }, (res) => {
        let buf = '';
        res.on('data', chunk => buf += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(buf);
            if (res.statusCode >= 400) {
              const err = new Error(parsed.error?.message || `HTTP ${res.statusCode}`);
              err.statusCode = res.statusCode;
              err.body = parsed;
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

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Relay request timed out'));
      });

      if (data) req.write(data);
      req.end();
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
   * @returns {Promise<{content: string, reasoning: string}>}
   */
  async chat(prompt, options = {}) {
    const model = options.model || process.env.M365_MODEL || 'gpt-5.5-think-deeper';
    const maxTokens = options.max_tokens || 4000;
    const temperature = options.temperature ?? 0.2;

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
    // The relay may wrap reasoning in <think> tags
    let reasoning = '';
    let finalContent = content;
    const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/);
    if (thinkMatch) {
      reasoning = thinkMatch[1].trim();
      finalContent = content.replace(/<think>[\s\S]*?<\/think>\s*/, '').trim();
    }

    return { content: finalContent, reasoning, raw: res };
  }
}

module.exports = { RelayClient };
