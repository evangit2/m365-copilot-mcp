#!/usr/bin/env node
/**
 * Auth Health Check for G365 Relay
 * 
 * Usage:
 *   node tools/auth-check.js              # check auth, exit 0=ready, 1=expired
 *   node tools/auth-check.js --quiet       # exit codes only, no output
 *   node tools/auth-check.js --json        # JSON output for scripts
 *   node tools/auth-check.js --screenshot  # capture VNC display too
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const PROFILE_DIR = path.resolve(__dirname, '..', 'profile');
const BRIDGE_PATH = path.resolve(__dirname, '..', 'lib', 'bridge.js');

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const json = args.includes('--json');
const screenshot = args.includes('--screenshot');

function log(msg, type = 'info') {
  if (quiet) return;
  if (json) return; // handled separately
  const prefix = type === 'error' ? '❌' : type === 'warn' ? '⚠️' : type === 'success' ? '✅' : 'ℹ️';
  console.log(`${prefix} ${msg}`);
}

function die(code, msg, data = {}) {
  if (json) {
    console.log(JSON.stringify({ ok: false, error: msg, ...data }, null, 2));
  } else if (!quiet) {
    log(msg, 'error');
  }
  process.exit(code);
}

function ok(msg, data = {}) {
  if (json) {
    console.log(JSON.stringify({ ok: true, message: msg, ...data }, null, 2));
  } else if (!quiet) {
    log(msg, 'success');
  }
  process.exit(0);
}

async function checkAuth() {
  // Screenshot VNC if requested
  if (screenshot) {
    try {
      execSync('DISPLAY=:99 import -window root /tmp/vnc_screenshot.png 2>/dev/null');
      log('VNC screenshot saved to /tmp/vnc_screenshot.png');
    } catch (e) {
      log('Could not capture VNC screenshot — Xvfb may not be running', 'warn');
    }
  }

  // Check if profile exists
  if (!fs.existsSync(PROFILE_DIR)) {
    die(2, 'Profile directory does not exist. Run sign-in first.', { profile: PROFILE_DIR });
  }

  // Check for Chrome locks (indicates crashed/still-running instance)
  const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  const hasLocks = lockFiles.some(f => fs.existsSync(path.join(PROFILE_DIR, f)));
  if (hasLocks) {
    log('Profile has stale Chrome locks — may need cleanup', 'warn');
  }

  // Try to launch a headless check page
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      args: [
        '--no-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=Translate',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-extensions',
        '--password-store=basic',
        '--use-mock-keychain',
        '--window-position=-32000,-32000',
        '--window-size=1280,720',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
    });
  } catch (e) {
    if (e.message.includes('existing browser session')) {
      die(3, 'Profile is locked by another Chrome instance. Kill all chrome processes first.', { hint: 'pkill -9 chromium; pkill -9 chrome' });
    }
    die(4, `Failed to launch browser: ${e.message}`);
  }

  let page;
  try {
    page = await ctx.newPage();

    // Inject bridge
    const bridgeSrc = fs.readFileSync(BRIDGE_PATH, 'utf-8');
    await page.addInitScript(bridgeSrc);

    // Navigate to M365 chat
    await page.goto('https://m365.cloud.microsoft/chat?auth=2', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Wait a moment for redirects
    await page.waitForTimeout(2000);

    // Check current URL
    const url = page.url();
    if (url.includes('login.microsoftonline.com')) {
      await ctx.close().catch(()=>{});
      die(1, 'Auth expired — redirect to Microsoft login page', {
        url: url.substring(0, 100),
        vncUrl: `http://${require('os').hostname()}:6080/vnc.html`,
        nextSteps: [
          'Open VNC URL in browser',
          'Sign in with your M365 credentials',
          'Complete Duo MFA',
          'Re-run this check',
        ],
      });
    }

    if (!url.includes('m365.cloud.microsoft')) {
      await ctx.close().catch(()=>{});
      die(5, `Unexpected redirect: ${url.substring(0, 100)}`);
    }

    // Wait for bridge to be ready
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        ready = await page.evaluate(() => !!(window.__m365Ready && window.__m365Ready()));
        if (ready) break;
      } catch (e) {}
      await page.waitForTimeout(1000);
      // Try priming
      if (i % 5 === 0) {
        try {
          const input = await page.$('[contenteditable="true"], textarea, [role="textbox"]');
          if (input) { await input.click(); await page.keyboard.type(' ', { delay: 5 }); }
        } catch (e) {}
      }
    }

    if (!ready) {
      await ctx.close().catch(()=>{});
      die(6, 'M365 page loaded but bridge is not ready. May need to sign in.', {
        url: url.substring(0, 100),
      });
    }

    // Verify we can set model
    try {
      await page.evaluate(() => {
        if (window.__m365SetModel) window.__m365SetModel('gpt-5.5-think-deeper');
      });
    } catch (e) {
      log('Model setter not available — bridge may be partially loaded', 'warn');
    }

    await ctx.close().catch(()=>{});
    ok('Auth healthy — M365 Copilot bridge is ready', {
      url: url.substring(0, 100),
      model: 'gpt-5.5-think-deeper',
    });

  } catch (e) {
    await ctx.close().catch(()=>{});
    die(7, `Unexpected error during check: ${e.message}`);
  }
}

checkAuth().catch(e => die(8, e.message));
