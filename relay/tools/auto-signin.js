#!/usr/bin/env node
/**
 * Headless M365 sign-in for g365-headless-relay
 *
 * Usage:
 *   node tools/auto-signin.js --email user@example.com --password secret
 *   M365_EMAIL=user@example.com M365_PASSWORD=secret node tools/auto-signin.js
 *   # with .env file (M365_EMAIL=... M365_PASSWORD=...)
 *   node tools/auto-signin.js
 *
 * Exit codes:
 *   0  success
 *   1  bad args / env
 *   2  blocked by MFA/captcha
 *   3  bad password
 *   4  timeout
 *   5  unexpected error
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PROFILE_DIR = process.env.PROFILE_DIR || path.resolve(__dirname, '..', 'profile');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf-8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, key, raw] = m;
    let val = raw;
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
    else if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

// Load .env from project root if present (no dotenv dependency)
loadEnvFile(path.resolve(__dirname, '..', '.env'));

// Simple CLI arg parsing (no deps)
const argv = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = process.argv[i + 1];
    if (next && !next.startsWith('--')) { argv[key] = next; i++; }
    else argv[key] = true;
  }
}

const email = process.env.M365_EMAIL || argv.email;
const password = process.env.M365_PASSWORD || argv.password;
const headless = !(process.env.HEADLESS === 'false' || argv.visible);

if (!email || !password) {
  console.error('Need M365_EMAIL and M365_PASSWORD.');
  console.error('  - Put them in .env in the project root, or');
  console.error('  - Export as environment variables, or');
  console.error('  - Pass --email and --password flags.');
  process.exit(1);
}

async function waitFor(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeText(s) { return s.toLowerCase().replace(/\s+/g, ' ').trim(); }

async function clickByText(page, textRegex, selector = 'button, input[type="submit"], a[role="button"], [role="button"]') {
  const els = await page.$$(selector);
  for (const el of els) {
    const txt = normalizeText(await el.evaluate(e => e.innerText || e.value || '').catch(() => ''));
    if (textRegex.test(txt)) {
      await el.click().catch(() => {});
      return true;
    }
  }
  return false;
}

(async () => {
  // Clear stale locks
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(PROFILE_DIR, f)); } catch (e) {}
  }

  const chromeArgs = [
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
    '--window-size=1280,720',
  ];
  if (headless) chromeArgs.push('--window-position=-32000,-32000');
  else chromeArgs.push('--window-position=0,0');

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, // M365 OAuth needs a real browser; hide via off-screen args
    args: chromeArgs,
    ignoreDefaultArgs: ['--enable-automation'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
  });

  const page = await ctx.newPage();

  try {
    console.log('[signin] Opening M365 Copilot Chat...');
    await page.goto('https://m365.cloud.microsoft/chat?auth=2', {
      waitUntil: 'networkidle',
      timeout: 60000,
    });
    await waitFor(2000);

    const startUrl = page.url();
    if (startUrl.startsWith('https://m365.cloud.microsoft/chat')) {
      console.log('[signin] Already authenticated');
      await ctx.close();
      process.exit(0);
    }

    // Email entry or account picker
    const emailInput = await page.$('input[type="email"], input[name="loginfmt"], input[autocomplete="username"]');
    if (emailInput) {
      console.log('[signin] Entering email...');
      await emailInput.fill(email);
      await clickByText(page, /next|continue|sign in/);
      await waitFor(3000);
    } else {
      // Account picker
      const tiles = await page.$$('[role="button"], .table, .tile, .accountPicker');
      let clicked = false;
      for (const tile of tiles) {
        const txt = await tile.evaluate(el => el.innerText).catch(() => '');
        if (normalizeText(txt).includes(email.toLowerCase())) {
          console.log('[signin] Selecting remembered account...');
          await tile.click();
          clicked = true;
          await waitFor(3000);
          break;
        }
      }
      if (!clicked) console.log('[signin] No account tile found, continuing...');
    }

    // Password
    const passInput = await page.$('input[type="password"], input[name="passwd"], input[autocomplete="current-password"]');
    if (passInput) {
      console.log('[signin] Entering password...');
      await passInput.fill(password);
      await clickByText(page, /sign in|next|submit/);
      await waitFor(4000);
    }

    // Wait for completion, handling intermediate prompts
    for (let i = 0; i < 60; i++) {
      const url = page.url();
      const body = await page.evaluate(() => document.body.innerText).catch(() => '');

      if (url.startsWith('https://m365.cloud.microsoft/chat')) {
        console.log('[signin] ✅ Signed in to M365 Copilot Chat');
        await waitFor(3000);
        await ctx.close();
        process.exit(0);
      }

      if (url.startsWith('https://www.office.com') || url.startsWith('https://outlook.office.com')) {
        console.log('[signin] ✅ Signed in (Office landing)');
        await ctx.close();
        process.exit(0);
      }

      const lower = normalizeText(body);

      if (lower.includes('stay signed in')) {
        console.log('[signin] Confirming "Stay signed in"');
        await clickByText(page, /yes|stay signed in/);
        await waitFor(3000);
        continue;
      }

      if (lower.includes('do this to reduce the number of times')) {
        // Sometimes no button text is just "Yes" / "No"; click first submit-ish
        const btn = await page.$('input[type="submit"], button[type="submit"]');
        if (btn) {
          console.log('[signin] Clicking default "Stay signed in" button');
          await btn.click();
          await waitFor(3000);
        }
        continue;
      }

      if (/account or password is incorrect|invalid username or password/.test(lower)) {
        console.log('[signin] ❌ Bad password');
        await ctx.close();
        process.exit(3);
      }

      if (/verify|two-step|authenticator|enter code|approve|we need to|unusual activity|suspicious|captcha|can't sign in|we didn\'t receive a response/.test(lower)) {
        console.log('[signin] ⚠️ Additional verification required (MFA/CAPTCHA)');
        await page.screenshot({ path: '/tmp/m365-signin-blocked.png' }).catch(() => {});
        await ctx.close();
        process.exit(2);
      }

      await waitFor(1000);
    }

    console.log('[signin] ❌ Timed out. Final URL:', page.url());
    await page.screenshot({ path: '/tmp/m365-signin-timeout.png' }).catch(() => {});
    await ctx.close();
    process.exit(4);

  } catch (e) {
    console.error('[signin] Error:', e.message);
    try { console.log('[signin] Final URL:', page.url()); } catch (_) {}
    await page.screenshot({ path: '/tmp/m365-signin-error.png' }).catch(() => {});
    await ctx.close().catch(() => {});
    process.exit(5);
  }
})();
