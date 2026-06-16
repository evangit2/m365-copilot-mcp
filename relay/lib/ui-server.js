const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const STATIC_DIR = path.join(__dirname, '..', 'chat-ui');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

let signInProc = null;

function getHostIp() {
  try {
    return execSync("hostname -I | awk '{print $1}'", { encoding: 'utf8' }).trim();
  } catch (e) { return 'localhost'; }
}

let capturedSubstrateUrl = null;

function serve(req, res) {
  const url = req.url.split('?')[0];

  // ── /substrate-url — bridge POSTs the captured substrate URL here
  if (url === '/substrate-url' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      capturedSubstrateUrl = body;
      console.log('[ui-server] captured substrate URL:', body.slice(0, 80) + '...');
      res.writeHead(200);
      res.end('ok');
    });
    return;
  }
  // ── /substrate-url — GET returns last captured URL ──
  if (url === '/substrate-url' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(capturedSubstrateUrl || '');
    return;
  }

  // ── /auth-status — quick auth health JSON ──
  if (url === '/auth-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: signInProc ? 'signin_in_progress' : 'unknown',
      vncUrl: `http://${getHostIp()}:6080/vnc.html`,
      timestamp: Date.now(),
    }));
    return;
  }

  // ── /reauth — launch visible browser for sign-in ──
  if (url === '/reauth') {
    // Kill existing sign-in browser
    if (signInProc) {
      try { signInProc.kill('SIGKILL'); } catch(e){}
      signInProc = null;
    }
    try {
      execSync('pkill -9 -f "chrome.*profile" 2>/dev/null; sleep 1; rm -f profile/SingletonLock profile/SingletonSocket* 2>/dev/null');
    } catch(e){}

    // Launch visible browser
    const scriptDir = path.join(__dirname, '..');
    signInProc = spawn('bash', [path.join(__dirname, '..', 'tools', 'open-signin.sh')], {
      cwd: scriptDir,
      detached: true,
      stdio: 'ignore',
    });
    signInProc.unref();

    const vncUrl = `http://${getHostIp()}:6080/vnc.html`;
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Re-authenticate — G365 Copilot</title>
  <style>
    :root {
      --bg: #0d1117; --bg-secondary: #161b22; --border: #30363d;
      --text: #c9d1d9; --text-muted: #8b949e; --accent: #58a6ff;
      --thinking: #a371f7; --success: #238636; --radius: 12px;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg); color: var(--text);
      min-height: 100vh; display: flex; flex-direction: column;
      align-items: center; justify-content: center; padding: 20px;
    }
    .card {
      max-width: 520px; width: 100%; background: var(--bg-secondary);
      border: 1px solid var(--border); border-radius: var(--radius);
      padding: 32px;
    }
    .card h1 { font-size: 20px; margin-bottom: 8px; }
    .card p { color: var(--text-muted); margin-bottom: 20px; line-height: 1.5; }
    .steps { list-style: none; margin-bottom: 24px; }
    .steps li {
      display: flex; align-items: flex-start; gap: 12px;
      padding: 10px 0; border-bottom: 1px solid var(--border);
    }
    .steps li:last-child { border-bottom: none; }
    .step-num {
      width: 24px; height: 24px; border-radius: 50%;
      background: var(--accent); color: white; font-size: 12px;
      font-weight: 600; display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    .step-text { font-size: 14px; line-height: 1.5; }
    .btn {
      display: inline-flex; align-items: center; justify-content: center;
      gap: 8px; background: var(--accent); color: white; text-decoration: none;
      padding: 12px 20px; border-radius: var(--radius); font-size: 14px;
      font-weight: 500; border: none; cursor: pointer; width: 100%;
    }
    .btn:hover { background: #2f81f7; }
    .btn.secondary {
      background: var(--bg-tertiary, #21262d); border: 1px solid var(--border);
      color: var(--text); margin-top: 10px;
    }
    .url-box {
      background: var(--bg); border: 1px solid var(--border);
      border-radius: 6px; padding: 10px 12px; font-family: monospace;
      font-size: 13px; word-break: break-all; margin: 12px 0;
    }
    .status { margin-top: 16px; font-size: 13px; color: var(--text-muted); }
    .status .dot {
      display: inline-block; width: 8px; height: 8px; border-radius: 50%;
      background: var(--success); margin-right: 6px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>🔐 Re-authenticate M365</h1>
    <p>A sign-in browser has been launched on the VNC display. Complete the steps below, then return to the chat.</p>
    <ol class="steps">
      <li><span class="step-num">1</span><span class="step-text">Open the VNC viewer below (or copy the URL)</span></li>
      <li><span class="step-num">2</span><span class="step-text">Enter your M365 email → click <strong>Next</strong></span></li>
      <li><span class="step-num">3</span><span class="step-text">Enter password → click <strong>Next</strong></span></li>
      <li><span class="step-num">4</span><span class="step-text">Complete Duo MFA (push / SMS / call)</span></li>
      <li><span class="step-num">5</span><span class="step-text">Wait for <code>m365.cloud.microsoft/chat</code> to load fully</span></li>
    </ol>
    <div class="url-box">${vncUrl}</div>
    <a class="btn" href="${vncUrl}" target="_blank">Open VNC Viewer</a>
    <a class="btn secondary" href="/" onclick="window.opener && window.opener.postMessage('auth-check','*'); window.close(); return false;">← Back to Chat</a>
    <div class="status"><span class="dot"></span> Sign-in browser launched</div>
  </div>
</body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    console.log('[ui-server] /reauth launched sign-in browser');
    return;
  }

  // ── Static files ──
  let filePath = path.join(STATIC_DIR, url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath).toLowerCase();

  if (!fs.existsSync(filePath)) {
    filePath = path.join(STATIC_DIR, 'index.html');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'text/plain' });
    res.end(data);
  });
}

function startUiServer(port = 3000) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(serve);
    server.listen(port, (err) => {
      if (err) return reject(err);
      console.log(`Chat UI: http://127.0.0.1:${port}`);
      resolve(server);
    });
  });
}

module.exports = { startUiServer };

