#!/usr/bin/env node
const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');

function send(child, id, method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
}

function waitForResponse(child, targetId, timeoutMs = 10000) {
  let buf = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for response ${targetId}`)), timeoutMs);
    function onData(chunk) {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { continue; }
        if (msg.id === targetId) {
          clearTimeout(timer);
          child.stdout.off('data', onData);
          resolve(msg);
          return;
        }
      }
    }
    child.stdout.on('data', onData);
  });
}

function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child did not exit after stdout pipe closed')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function main() {
  const healthServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', has_template: true }));
  });
  await new Promise(resolve => healthServer.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${healthServer.address().port}`;

  let stderr = '';
  const child = spawn(process.execPath, ['mcp-server.js'], {
    cwd: __dirname,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      RELAY_URL: baseUrl,
      AUTH_MODE: 'existing',
      G365_RELAY_REPO: '/tmp/does-not-matter-health-is-ready',
    },
  });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });

  try {
    send(child, 1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'epipe-test', version: '1.0.0' },
    });
    const init = await waitForResponse(child, 1);
    assert.ok(init.result, `initialize failed: ${JSON.stringify(init)}`);

    // Simulate the MCP client disappearing while the server is still alive.
    // The next response write will hit EPIPE/ERR_STREAM_DESTROYED unless the
    // server handles closed stdio cleanly.
    child.stdout.destroy();
    send(child, 2, 'tools/list', {});

    const exit = await waitForExit(child);
    assert.strictEqual(exit.code, 0, `expected graceful exit, got ${JSON.stringify(exit)} stderr=${stderr}`);
    assert.ok(!/Unhandled 'error' event|write EPIPE|Node\.js v\d+/i.test(stderr), `stderr shows crash:\n${stderr}`);
  } finally {
    if (!child.killed) child.kill('SIGTERM');
    await new Promise(resolve => healthServer.close(resolve));
  }

  console.log('epipe test ok');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
