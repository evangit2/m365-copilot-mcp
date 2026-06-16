const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const userDataDir = path.resolve(__dirname, 'profile');

  const args = [
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
    '--window-position=0,0',
  ];

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args,
    ignoreDefaultArgs: ['--enable-automation'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
  });

  const page = await ctx.newPage();
  await page.goto('https://m365.cloud.microsoft/chat?auth=2', { waitUntil: 'domcontentloaded', timeout: 60000 });

  console.log('Browser open. Press Ctrl+C to close.');
  // Keep browser open
  await new Promise(() => {});
})();
