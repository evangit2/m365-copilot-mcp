const { chromium } = require('playwright');
const path = require('path');

const DEFAULT_PROFILE = path.join(__dirname, '..', 'profile');

async function launchPersistentBrowser(profilePath, headless) {
  const userDataDir = path.resolve(profilePath || DEFAULT_PROFILE);

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

  // No off-screen positioning — always visible on VNC

  return chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args,
    ignoreDefaultArgs: ['--enable-automation'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
  });
}

module.exports = { launchPersistentBrowser, DEFAULT_PROFILE };
