/**
 * Auth manager for m365-copilot-mcp.
 *
 * Supports three sign-in modes:
 *   1. credentials  - uses g365-headless-relay/tools/auto-signin.js with M365_EMAIL + M365_PASSWORD
 *   2. vnc          - asks the user to sign in manually via the VNC URL, then waits for /health
 *   3. existing     - just reuse an already-warmed relay (RELAY_URL only)
 *
 * This module deliberately does NOT store credentials itself.  They are read
 * from the environment or from a gitignored .env file.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const RELAY_READY_TIMEOUT_MS = 120000;
const RELAY_POLL_INTERVAL_MS = 3000;

class AuthManager {
  constructor({
    relayUrl = 'http://127.0.0.1:9000',
    relayRepo = null, // path to g365-headless-relay
    mode = 'existing', // 'credentials' | 'vnc' | 'existing'
  } = {}) {
    this.relayUrl = relayUrl;
    this.relayRepo = relayRepo || process.env.G365_RELAY_REPO || this._findRelayRepo();
    this.mode = mode || (process.env.M365_EMAIL ? 'credentials' : 'existing');
    this.relayProcess = null;
  }

  _findRelayRepo() {
    const candidates = [
      path.join(process.env.HOME, 'projects', 'g365-headless-relay'),
      path.join(process.env.HOME, 'g365-headless-relay'),
      path.join(process.cwd(), '..', 'g365-headless-relay'),
      path.join(process.cwd(), 'g365-headless-relay'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(path.join(c, 'index.js'))) return c;
    }
    return null;
  }

  async ensureRelayRunning() {
    if (await this._relayReady()) {
      console.error('[auth] Relay already running and ready');
      return { url: this.relayUrl, started: false };
    }

    if (!this.relayRepo) {
      throw new Error('g365-headless-relay repo not found. Set G365_RELAY_REPO or install it next to this project.');
    }

    if (this.mode === 'credentials') {
      if (!process.env.M365_EMAIL || !process.env.M365_PASSWORD) {
        throw new Error('M365_EMAIL and M365_PASSWORD required for credentials mode');
      }
      await this._runAutoSignin();
    }

    console.error(`[auth] Starting relay from ${this.relayRepo}`);
    this.relayProcess = spawn(
      './start.sh',
      [],
      {
        cwd: this.relayRepo,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          OPENAI_API_PORT: this._extractPort(this.relayUrl),
          OPENAI_API_HOST: '0.0.0.0',
        },
      }
    );

    this.relayProcess.stdout.on('data', d => process.stderr.write(`[relay] ${d}`));
    this.relayProcess.stderr.on('data', d => process.stderr.write(`[relay] ${d}`));

    const ready = await this._waitForRelay();
    if (!ready) {
      throw new Error('Relay did not become ready in time');
    }

    if (this.mode === 'vnc') {
      const vncUrl = `http://127.0.0.1:6080/vnc.html`;
      console.error(`[auth] VNC sign-in mode. Open ${vncUrl} in a browser, sign in to M365, then return here.`);
      // In stdio MCP mode we can't truly block for the user, but we keep waiting
      // for /health. The user must complete sign-in via VNC.
      let vncReady = false;
      const vncDeadline = Date.now() + 600000; // 10 minutes
      while (Date.now() < vncDeadline) {
        if (await this._relayReady()) { vncReady = true; break; }
        await sleep(5000);
      }
      if (!vncReady) throw new Error('VNC sign-in was not completed in time');
    }

    return { url: this.relayUrl, started: true };
  }

  async _runAutoSignin() {
    const signinScript = path.join(this.relayRepo, 'tools', 'auto-signin.js');
    if (!fs.existsSync(signinScript)) {
      throw new Error(`auto-signin.js not found at ${signinScript}`);
    }
    console.error('[auth] Running headless M365 sign-in...');
    return new Promise((resolve, reject) => {
      const child = spawn('node', [signinScript], {
        cwd: this.relayRepo,
        stdio: 'inherit',
        env: {
          ...process.env,
          DISPLAY: process.env.DISPLAY || ':99',
          M365_EMAIL: process.env.M365_EMAIL,
          M365_PASSWORD: process.env.M365_PASSWORD,
          PROFILE_DIR: process.env.PROFILE_DIR || path.join(this.relayRepo, 'profile'),
        },
      });
      child.on('exit', code => {
        if (code === 0) resolve();
        else reject(new Error(`auto-signin exited with code ${code}`));
      });
    });
  }

  _extractPort(url) {
    try { return new URL(url).port || '9000'; }
    catch (e) { return '9000'; }
  }

  async _waitForRelay() {
    const deadline = Date.now() + RELAY_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this._relayReady()) return true;
      await sleep(RELAY_POLL_INTERVAL_MS);
    }
    return false;
  }

  async _relayReady() {
    return new Promise((resolve) => {
      const req = require('http').get(`${this.relayUrl}/health`, (res) => {
        let buf = '';
        res.on('data', chunk => buf += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(buf);
            resolve(res.statusCode === 200 && json.status === 'ok');
          } catch (e) { resolve(false); }
        });
      });
      req.on('error', () => resolve(false));
      req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    });
  }

  stopRelay() {
    if (this.relayProcess) {
      try { this.relayProcess.kill('SIGTERM'); } catch (e) {}
      this.relayProcess = null;
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { AuthManager };
