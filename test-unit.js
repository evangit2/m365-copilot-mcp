#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { loadEnvFile } = require('./lib/env');
const { RelayClient, buildRelayError, isAuthExpiredMessage, isRateLimitMessage } = require('./lib/relay-client');

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testEnvLoader() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm365-mcp-env-'));
  const envPath = path.join(tmp, '.env');
  fs.writeFileSync(envPath, [
    '# comment',
    'RELAY_URL=http://example.test:9000',
    'QUOTED="hello world"',
    "SINGLE='abc#def'",
    'INLINE=value # comment',
    'G365_RELAY_REPO=$HOME/projects/g365-headless-relay',
    'ALT_HOME=${HOME}/alt',
    'BAD KEY=nope',
    '',
  ].join('\n'));

  const env = { RELAY_URL: 'http://override.test', HOME: '/tmp/home-for-test' };
  const result = loadEnvFile(envPath, env);
  assert.strictEqual(result.loaded, true);
  assert.strictEqual(env.RELAY_URL, 'http://override.test', 'existing env wins');
  assert.strictEqual(env.QUOTED, 'hello world');
  assert.strictEqual(env.SINGLE, 'abc#def');
  assert.strictEqual(env.INLINE, 'value');
  assert.strictEqual(env.G365_RELAY_REPO, '/tmp/home-for-test/projects/g365-headless-relay');
  assert.strictEqual(env.ALT_HOME, '/tmp/home-for-test/alt');
  assert.strictEqual(env.BAD, undefined);
}

async function testRelayClientClearsTimers() {
  await withServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok' }));
  }, async (baseUrl) => {
    const startHandles = process._getActiveHandles().length;
    const health = await new RelayClient({ baseUrl, timeoutMs: 200 }).health();
    assert.strictEqual(health.status, 'ok');
    await new Promise(resolve => setTimeout(resolve, 20));
    const endHandles = process._getActiveHandles().length;
    assert.ok(endHandles <= startHandles + 2, `suspected leaked handles: before=${startHandles} after=${endHandles}`);
  });
}

async function testErrorClassification() {
  const auth = buildRelayError(502, { error: { message: 'Substrate connection error: Unexpected server response: 401', type: 'relay_error' } });
  assert.strictEqual(auth.code, 'M365_AUTH_EXPIRED');
  assert.strictEqual(auth.retryable, false);
  assert.ok(auth.message.includes('captured Substrate token'));
  assert.strictEqual(isAuthExpiredMessage(401, 'Unauthorized'), true);

  const limit = buildRelayError(429, { error: { message: "You've reached the limit on the number of requests per hour." } });
  assert.strictEqual(limit.code, 'M365_RATE_LIMIT');
  assert.strictEqual(limit.retryable, false);
  assert.strictEqual(isRateLimitMessage(500, 'rate limit exceeded'), true);
}

async function testNoRetryOnAuthExpired() {
  let count = 0;
  await withServer((req, res) => {
    count++;
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { message: 'Substrate connection error: Unexpected server response: 401' } }));
  }, async (baseUrl) => {
    const client = new RelayClient({ baseUrl, timeoutMs: 200 });
    await assert.rejects(() => client.chat('hello'), err => err.code === 'M365_AUTH_EXPIRED');
    assert.strictEqual(count, 1, 'auth-expired errors should not be retried');
  });
}

async function main() {
  await testEnvLoader();
  await testRelayClientClearsTimers();
  await testErrorClassification();
  await testNoRetryOnAuthExpired();
  console.log('unit tests ok');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
