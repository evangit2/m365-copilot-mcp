#!/usr/bin/env node
/**
 * Minimal MCP client over stdio to exercise mcp-server.js end-to-end.
 * Run this while the relay is already healthy.
 */
const { spawn } = require('child_process');

const server = spawn('node', ['mcp-server.js'], { cwd: __dirname, stdio: ['pipe', 'pipe', 'inherit'] });

let buf = '';
let id = 0;

function send(method, params) {
  const msg = { jsonrpc: '2.0', id: ++id, method, params };
  server.stdin.write(JSON.stringify(msg) + '\n');
  return id;
}

function expectResponse(targetId, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MCP response timeout')), timeoutMs);
    function onData(chunk) {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === targetId) {
            clearTimeout(timer);
            server.stdout.off('data', onData);
            resolve(msg);
          }
        } catch (e) {}
      }
    }
    server.stdout.on('data', onData);
  });
}

async function run() {
  send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } });
  const init = await expectResponse(1);
  console.log('initialize:', JSON.stringify(init.result ? 'ok' : init.error));

  send('tools/list', {});
  const tools = await expectResponse(2);
  console.log('tools:', tools.result?.tools?.map(t => t.name).join(', '));

  send('tools/call', { name: 'm365_copilot_status', arguments: {} });
  const status = await expectResponse(3);
  console.log('status:', status.result?.content?.[0]?.text);

  server.kill('SIGTERM');
}

run().catch(err => {
  console.error('Test failed:', err);
  server.kill('SIGTERM');
  process.exit(1);
});
