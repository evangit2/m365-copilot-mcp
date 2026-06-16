const path = require('path');
const { launchPersistentBrowser, DEFAULT_PROFILE } = require('./lib/browser');
const { createServer } = require('./lib/server');
const { startUiServer } = require('./lib/ui-server');
const { createOpenAiServer } = require('./lib/openai-server');
const { Semaphore } = require('./lib/queue');
const { DirectHistory } = require('./lib/direct-history');

const DEFAULT_PORT = 8765;
const DEFAULT_INTERVAL_MINUTES = 50;
const DEFAULT_OPENAI_PORT = 9000;

function printHelp() {
  console.log([
    '',
    'G365 M365 Copilot Relay — GPT 5.5 Think Deeper Edition',
    '',
    '  node index.js --headless       Off-screen relay (default)',
    '  node index.js --no-headless    Visible browser for login',
    '',
    'Options:',
    '  --port <n>            Relay WS port (default: ' + DEFAULT_PORT + ')',
    '  --ui-port <n>         Chat UI HTTP port (default: 3000)',
    '  --openai-port <n>     OpenAI-compatible HTTP port (default: ' + DEFAULT_OPENAI_PORT + ')',
    '  --openai-host <ip>    Bind host for OpenAI HTTP API (default: 0.0.0.0)',
    '  --openai-key <key>    Bearer token required on /v1/* endpoints',
    '  --profile <dir>       Browser profile dir (default: ./profile)',
    '  --pool-size <n>       Pages to warm for template capture (default: 1)',
    '  --max-concurrency <n> Concurrent M365 streams allowed (default: 10)',
    '  --headless            Run off-screen (hidden window)',
    '  --no-headless         Show browser window for interactive login',
    '  --interval <min>      Session keepalive refresh (default: ' + DEFAULT_INTERVAL_MINUTES + ')',
    '  --no-ui               Don\'t start the chat UI server',
    '',
  ].join('\n'));
}

function parseArgs(argv) {
  const a = {
    profile: DEFAULT_PROFILE,
    relayPort: DEFAULT_PORT,
    uiPort: 3000,
    openAiPort: process.env.OPENAI_API_PORT ? parseInt(process.env.OPENAI_API_PORT, 10) : DEFAULT_OPENAI_PORT,
    openAiHost: process.env.OPENAI_API_HOST || '0.0.0.0',
    openAiKey: process.env.OPENAI_API_KEY || null,
    openAiMaxChars: process.env.OPENAI_MAX_CHARS ? parseInt(process.env.OPENAI_MAX_CHARS, 10) : 100000,
    maxConcurrency: process.env.MAX_CONCURRENCY ? parseInt(process.env.MAX_CONCURRENCY, 10) : 10,
    headless: true,
    interval: DEFAULT_INTERVAL_MINUTES,
    noUi: false,
    help: false,
    poolSize: 1, // only need 1 warmed page to capture template; direct mode after that
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--port': a.relayPort = parseInt(argv[++i]) || DEFAULT_PORT; break;
      case '--ui-port': a.uiPort = parseInt(argv[++i]) || 3000; break;
      case '--openai-port': a.openAiPort = parseInt(argv[++i]) || DEFAULT_OPENAI_PORT; break;
      case '--openai-host': a.openAiHost = argv[++i] || '0.0.0.0'; break;
      case '--openai-key': a.openAiKey = argv[++i] || null; break;
      case '--profile': a.profile = argv[++i]; break;
      case '--headless': a.headless = true; break;
      case '--no-headless': a.headless = false; break;
      case '--interval': a.interval = parseInt(argv[++i]) || DEFAULT_INTERVAL_MINUTES; break;
      case '--pool-size': a.poolSize = parseInt(argv[++i]) || 1; break;
      case '--max-concurrency': a.maxConcurrency = parseInt(argv[++i]) || 10; break;
      case '--no-ui': a.noUi = true; break;
      case '--help': case '-h': a.help = true; break;
    }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }

  console.log('╔═══════════════════════════════════════╗');
  console.log('║  G365 Copilot Relay                   ║');
  console.log('║  Default: GPT 5.5 Think Deeper        ║');
  console.log('╚═══════════════════════════════════════╝\n');
  console.log('Profile: ' + args.profile);
  console.log('Mode: ' + (args.headless ? 'off-screen' : 'visible'));
  console.log('');

  const ctx = await launchPersistentBrowser(args.profile, args.headless);
  args.ctx = ctx;

  const sharedState = { cachedTemplateUrl: null };
  args.sharedState = sharedState;

  const semaphore = new Semaphore(args.maxConcurrency);

  const { wss, drain } = createServer(args);

  const openAi = createOpenAiServer({
    getTemplateUrl: () => sharedState.cachedTemplateUrl,
    semaphore,
    apiKey: args.openAiKey,
    port: args.openAiPort,
    host: args.openAiHost,
    maxChars: args.openAiMaxChars,
    requestLogPath: process.env.REQUEST_LOG || null,
  });

  if (!args.noUi) {
    await startUiServer(args.uiPort);
  }

  process.on('SIGINT', function() {
    console.log('\nShutting down...');
    drain();
    wss.close();
    openAi.server.close();
    process.exit(0);
  });

  console.log('Relay WS:    ws://127.0.0.1:' + args.relayPort);
  console.log('OpenAI API:  http://' + args.openAiHost + ':' + args.openAiPort);
  console.log('Waiting for connections...\n');
}

if (require.main === module) {
  main().catch(function(err) {
    console.error('Fatal: ' + err.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, printHelp };
