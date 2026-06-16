const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const userDataDir = path.resolve(process.cwd(), 'profile');
  
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,720',
      '--window-position=0,0',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
    env: { ...process.env, DISPLAY: ':99' }
  });
  
  const page = await ctx.newPage();
  page.on('console', msg => console.log('[PAGE]', msg.text()));
  
  console.log('Navigating to M365...');
  await page.goto('https://m365.cloud.microsoft/chat?auth=2', { 
    waitUntil: 'domcontentloaded', 
    timeout: 60000 
  });
  
  console.log('URL:', page.url());
  console.log('Keep browser open...');
  
  // Keep alive
  setInterval(() => {}, 60000);
})();
