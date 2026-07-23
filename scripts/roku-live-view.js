'use strict';
// Standalone ~1fps live view of a Roku screen in your browser — for demos/presentations.
//
// Reuses the e2e lane's dev-screenshot driver (lib/e2e/ecp.js): it polls the Roku dev screenshot
// endpoint back-to-back (each capture is ≈1.1s, so the feed tops out around 1 fps — a slideshow, not
// motion capture; true video needs an HDMI capture card) and serves the frames as an MJPEG stream the
// browser renders live with no client-side JavaScript.
//
// Usage:
//   node scripts/roku-live-view.js --host <ip> --password <dev-pw> [--port 8600] [--app dev]
//   ROKU_HOST=<ip> ROKU_PASSWORD=<pw> node scripts/roku-live-view.js
//
// Options:
//   --host <ip>        Roku IP on the LAN            (or ROKU_HOST)
//   --password <pw>    Roku developer password       (or ROKU_PASSWORD) — required for screenshots
//   --port <n>         Local HTTP server port        (default 8600)
//   --interval <ms>    Extra gap between captures     (default 0 — capture back-to-back, ~1fps)
//   --app [id]         Launch a channel first (e.g. dev); with no id, pick from the device's app list
//   -o, --open         Open the browser on start
//   -h, --help         Show this help
//
// While running (in a TTY): press `o` to open the browser, `q` (or Ctrl-C) to quit.
// The device must be in developer mode with ECP Network access = Permissive.
// Zero external dependencies — only Node built-ins + lib/e2e/ecp.js.

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { createDevice } = require(path.join(__dirname, '..', 'lib', 'e2e', 'ecp.js'));

// Open a URL in the default browser (macOS `open`, Windows `start`, else `xdg-open`).
function openBrowser(url) {
  let cmd, cmdArgs;
  if (process.platform === 'darwin') { cmd = 'open'; cmdArgs = [url]; }
  else if (process.platform === 'win32') { cmd = 'cmd'; cmdArgs = ['/c', 'start', '', url]; }
  else { cmd = 'xdg-open'; cmdArgs = [url]; }
  try { spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).unref(); }
  catch (e) { process.stderr.write(`could not open browser: ${e.message}\n`); }
}

// Parse the ECP /query/apps XML into [{ id, type, version, name }] (attribute-order independent).
function parseApps(xml) {
  const apps = [];
  for (const m of String(xml || '').matchAll(/<app\b([^>]*)>([^<]*)<\/app>/g)) {
    const attrs = m[1];
    // Require start-or-whitespace before the name so `type=` doesn't match inside `subtype=`.
    const attr = (k) => { const mm = attrs.match(new RegExp(`(?:^|\\s)${k}="([^"]*)"`)); return mm ? mm[1] : ''; };
    apps.push({ id: attr('id'), type: attr('type'), version: attr('version'), name: m[2].trim() });
  }
  return apps;
}

// Ask a one-line question on the terminal and resolve with the typed answer.
function prompt(question) {
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => { rl.close(); resolve(ans); });
  });
}

// List the device's installed apps and let the user pick one to launch. Returns the chosen appId, or
// null if none was chosen / it can't prompt. Only the sideloaded dev channel is screenshot-capturable.
async function chooseApp(device) {
  let apps;
  try {
    const { status, text } = await device.ecpGet('/query/apps');
    if (status !== 200) throw new Error(`HTTP ${status}`);
    apps = parseApps(text);
  } catch (e) {
    process.stderr.write(`  Could not list apps (/query/apps: ${e.message}). Pass --app <id> instead.\n`);
    return null;
  }
  if (!apps.length) { process.stderr.write('  No apps reported by the device.\n'); return null; }

  // Which one is running now (best-effort — used only to annotate the list).
  let activeId = null;
  try {
    const { text } = await device.ecpGet('/query/active-app');
    activeId = (parseApps(text)[0] || {}).id || null;
  } catch { /* ignore */ }

  process.stdout.write('\n  Apps on the device:\n');
  apps.forEach((a, i) => {
    const tags = [];
    if (a.id === 'dev') tags.push('sideloaded dev — capturable');
    if (a.id === activeId) tags.push('running');
    const tag = tags.length ? `  ← ${tags.join(', ')}` : '';
    process.stdout.write(`    ${String(i + 1).padStart(2)}) ${a.name || '(unnamed)'}  [id ${a.id}]${tag}\n`);
  });

  if (!process.stdin.isTTY) {
    process.stderr.write('  (no interactive terminal — re-run with --app <id> to launch one of the above.)\n');
    return null;
  }

  const answer = await prompt('\n  Choose an app number to launch (Enter to skip): ');
  const n = parseInt(answer, 10);
  if (!answer.trim() || Number.isNaN(n) || n < 1 || n > apps.length) {
    process.stdout.write('  No app launched.\n');
    return null;
  }
  const chosen = apps[n - 1];
  if (chosen.id !== 'dev') {
    process.stdout.write(`  Note: "${chosen.name}" isn't the sideloaded dev channel — screenshots will likely 404/black.\n`);
  }
  return chosen.id;
}

// ---- args ----------------------------------------------------------------
function parseArgs(argv) {
  const out = { port: 8600, interval: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--host') out.host = next();
    else if (a === '--password') out.password = next();
    else if (a === '--port') out.port = parseInt(next(), 10);
    else if (a === '--interval') out.interval = parseInt(next(), 10);
    else if (a === '--app') {
      const peek = argv[i + 1];
      if (peek === undefined || peek === '' || peek.startsWith('-')) {
        out.appMenu = true;          // --app with no/empty value → choose interactively
        if (peek === '') i++;        // consume an explicit empty-string arg; leave real flags alone
      } else out.app = argv[++i];
    }
    else if (a === '--open' || a === '-o') out.open = true;
    else throw new Error(`unknown option: ${a}`);
  }
  return out;
}

const HELP = `
roku-live-view — ~1fps live Roku screen in the browser (demo aid)

Usage:
  node scripts/roku-live-view.js --host <ip> --password <dev-pw> [--port 8600] [--app dev]
  ROKU_HOST=<ip> ROKU_PASSWORD=<pw> node scripts/roku-live-view.js

Options:
  --host <ip>       Roku IP on the LAN         (or ROKU_HOST)
  --password <pw>   Roku developer password    (or ROKU_PASSWORD) — required
  --port <n>        Local HTTP server port      (default 8600)
  --interval <ms>   Extra gap between captures  (default 0 — ~1fps back-to-back)
  --app [id]        Launch a channel first (e.g. dev); no id = choose from the device's app list
  -o, --open        Open the browser on start
  -h, --help        Show this help

While running (in a TTY): press o to open the browser, q (or Ctrl-C) to quit.
Device must be in developer mode with ECP Network access = Permissive.
Open the printed http://localhost:<port> URL. Live video needs HDMI capture — this is a slideshow.
`;

// ---- shared state --------------------------------------------------------
let latest = null;              // { buffer, ext, ts }
let lastError = null;           // string
let captures = 0;
const streamClients = new Set(); // res objects subscribed to the MJPEG feed
const BOUNDARY = 'brighttestframe';

function mimeFor(ext) {
  return ext === 'png' ? 'image/png' : 'image/jpeg';
}

// Map a screenshot failure to an actionable hint (the dev screenshot endpoint's errors are cryptic).
function hintFor(msg) {
  if (/HTTP 404/.test(msg)) {
    return 'The dev screenshot endpoint only serves a frame while a *sideloaded dev channel* is the ' +
      'running app. The Roku home screen and published (store) channels are not capturable. ' +
      'Sideload your channel and open it (or re-run with --app <id> to launch it), then frames will appear.';
  }
  if (/HTTP 401/.test(msg)) return 'Auth rejected — check the --password (the Roku *developer* password, user rokudev).';
  if (/HTTP 403|Limited mode/.test(msg)) {
    return 'ECP is in Limited mode — set Settings → System → Advanced → Control by mobile apps → ' +
      'Network access → Permissive.';
  }
  return null;
}

// Push a freshly-captured frame to every connected MJPEG client.
function broadcast(frame) {
  const head = Buffer.from(
    `--${BOUNDARY}\r\n` +
    `Content-Type: ${mimeFor(frame.ext)}\r\n` +
    `Content-Length: ${frame.buffer.length}\r\n\r\n`,
    'utf8'
  );
  const tail = Buffer.from('\r\n', 'utf8');
  for (const res of streamClients) {
    try {
      res.write(head);
      res.write(frame.buffer);
      res.write(tail);
    } catch {
      streamClients.delete(res);
    }
  }
}

// ---- capture loop --------------------------------------------------------
async function captureLoop(device, intervalMs) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let loggedError = null; // last error message printed, so we don't spam identical failures each ~1s
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const { buffer, ext } = await device.screenshot();
      const firstFrame = !latest;
      latest = { buffer, ext, ts: Date.now() };
      captures++;
      broadcast(latest);
      if (firstFrame) process.stdout.write('  ✓ first frame captured — the browser view should be live now.\n');
      else if (lastError) process.stdout.write('  ✓ capture recovered.\n');
      lastError = null;
      loggedError = null;
    } catch (e) {
      lastError = e && e.message ? e.message : String(e);
      if (lastError !== loggedError) {
        process.stderr.write(`  ⚠ screenshot failed: ${lastError}\n`);
        const hint = hintFor(lastError);
        if (hint) process.stderr.write(`    → ${hint}\n`);
        loggedError = lastError;
      }
    }
    if (intervalMs > 0) await sleep(intervalMs);
  }
}

// ---- HTTP server ---------------------------------------------------------
function page(host, info) {
  const model = info ? `${info.name || 'Roku'} · ${info.model || ''} · fw ${info.firmware || '?'}` : host;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Roku live · ${host}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.4 -apple-system, system-ui, sans-serif;
         background: #0b0b0d; color: #e8e8ea; display: flex; flex-direction: column;
         min-height: 100vh; align-items: center; }
  header { width: 100%; padding: 10px 16px; background: #141417; border-bottom: 1px solid #26262b;
           display: flex; gap: 12px; align-items: baseline; }
  header b { font-size: 15px; }
  header span { color: #9a9aa2; font-size: 12px; }
  .wrap { flex: 1; display: flex; align-items: center; justify-content: center; width: 100%; padding: 16px; }
  img { max-width: 100%; max-height: calc(100vh - 110px); border-radius: 8px;
        box-shadow: 0 8px 40px rgba(0,0,0,.6); background: #000; }
  footer { color: #6d6d75; font-size: 12px; padding: 8px 16px 16px; text-align: center; }
  code { color: #b7b7bf; }
</style></head><body>
<header><b>Roku live view</b><span>${model} — ~1&nbsp;fps (slideshow; true video needs HDMI capture)</span></header>
<div class="wrap"><img src="/stream.mjpeg" alt="Roku screen — waiting for first frame…"></div>
<footer>Reusing brighttest's dev-screenshot driver. If the image stalls, the device may be asleep or ECP is not Permissive.</footer>
</body></html>`;
}

function startServer({ port, host, info }) {
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];

    if (url === '/' || url === '/index.html') {
      const html = page(host, info);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (url === '/frame.jpg') {
      if (!latest) { res.writeHead(503).end('no frame yet'); return; }
      res.writeHead(200, { 'Content-Type': mimeFor(latest.ext), 'Cache-Control': 'no-store' });
      res.end(latest.buffer);
      return;
    }

    if (url === '/stream.mjpeg') {
      res.writeHead(200, {
        'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Connection: 'close',
        Pragma: 'no-cache',
      });
      // Flush headers now so the connection establishes immediately — otherwise Node buffers them until
      // the first body byte, and if no frame has been captured yet the request hangs on "provisional
      // headers" forever. Disable the socket idle-timeout so a slow ~1fps feed isn't dropped.
      res.flushHeaders();
      if (res.socket) res.socket.setTimeout(0);
      streamClients.add(res);
      if (latest) broadcast({ ...latest }); // seed the newcomer with the current frame
      req.on('close', () => streamClients.delete(res));
      return;
    }

    if (url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ captures, clients: streamClients.size, lastError, hasFrame: !!latest }));
      return;
    }

    res.writeHead(404).end('not found');
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, () => resolve(server));
  });
}

// ---- main ----------------------------------------------------------------
async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n${HELP}`);
    process.exit(2);
  }
  if (args.help) { process.stdout.write(HELP); return; }

  const host = args.host || process.env.ROKU_HOST;
  const password = args.password || process.env.ROKU_PASSWORD;
  if (!host) { process.stderr.write(`Missing --host (or ROKU_HOST).\n${HELP}`); process.exit(2); }
  if (!password) { process.stderr.write(`Missing --password (or ROKU_PASSWORD) — needed for screenshots.\n${HELP}`); process.exit(2); }

  const device = createDevice({ host, password });

  // Confirm the device is reachable + in dev mode; also grab a nice header label.
  let info = null;
  try {
    info = await device.deviceInfo();
    if (!info.developerEnabled) {
      process.stderr.write(`Warning: ${host} does not report developer mode enabled — screenshots may fail.\n`);
    }
  } catch (e) {
    process.stderr.write(`Could not reach ${host}: ${e.message}\n(Is it a Roku on this LAN?)\n`);
    process.exit(1);
  }

  if (args.appMenu) args.app = await chooseApp(device);

  if (args.app) {
    try { await device.launch(args.app); }
    catch (e) { process.stderr.write(`Launch of "${args.app}" failed: ${e.message}\n`); }
  }

  let server;
  try {
    server = await startServer({ port: args.port, host, info });
  } catch (e) {
    process.stderr.write(`Could not start server on port ${args.port}: ${e.message}\n`);
    process.exit(1);
  }

  const url = `http://localhost:${args.port}`;
  const keyHint = process.stdin.isTTY ? 'press o to open the browser, q to quit' : 'Ctrl-C to stop';
  process.stdout.write(
    `\n  Roku live view → ${url}\n` +
    `  device: ${info.name || 'Roku'} (${info.model || '?'}, fw ${info.firmware || '?'})\n` +
    `  ~1 fps slideshow — ${keyHint}.\n\n`
  );

  const shutdown = () => {
    if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch {} }
    for (const res of streamClients) { try { res.end(); } catch {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (args.open) openBrowser(url);

  // Interactive shortcuts when attached to a terminal: `o` opens the browser, `q`/Ctrl-C quits.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (key) => {
      if (key === 'o' || key === 'O') openBrowser(url);
      else if (key === 'q' || key === 'Q' || key === '\u0003') shutdown(); // \u0003 = Ctrl-C in raw mode
    });
  }

  // Never resolves — runs until the process is killed.
  await captureLoop(device, args.interval > 0 ? args.interval : 0);
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`roku-live-view: ${e && e.stack ? e.stack : e}\n`);
    process.exit(1);
  });
}

// Exported for testing (the HTTP surface + frame plumbing) without a real device.
module.exports = {
  parseArgs,
  parseApps,
  page,
  startServer,
  // Inject a frame as the capture loop would, so tests can exercise /frame.jpg and /stream.mjpeg.
  __pushFrame(buffer, ext = 'jpg') {
    latest = { buffer, ext, ts: 1 };
    captures++;
    broadcast(latest);
  },
};
