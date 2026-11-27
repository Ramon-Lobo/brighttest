#!/usr/bin/env node
'use strict';
// Regenerates the Studio screenshots used by docs/guide/studio.md (docs/public/images/studio/*.png).
//
//   npm run studio:build && node scripts/docs-screenshots.js [--out <dir>]
//
// Device-free and dependency-free: it starts the in-repo fake Roku (test/fixtures/fake-roku) and Studio in this process,
// feeds Studio a scripted in-process hub that acks edits (a stand-in for an instrumented app), then drives a headless
// Chrome over the DevTools protocol (Node's global WebSocket). Nothing touches a real Roku. Chrome is found via
// $CHROME_BIN or the usual install paths. Every process it starts is closed on exit, and a 120 s alarm ends the run.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const root = path.join(__dirname, '..');
const outIdx = process.argv.indexOf('--out');
const outDir = outIdx > 0 ? path.resolve(process.argv[outIdx + 1]) : path.join(root, 'docs', 'public', 'images', 'studio');
const W = 1280, H = 1180;

function findChrome() {
  const c = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  return c.find((p) => fs.existsSync(p));
}
// A plain generic gradient frame (no app content), encoded with zlib: stands in for the device screenshot.
function placeholderPng(w = 480, h = 270) {
  const zlib = require('zlib');
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 40 + (x * 60) / w; raw[o + 1] = 40 + (y * 40) / h; raw[o + 2] = 90 + (x * 70) / w; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));

async function main() {
  if (!fs.existsSync(path.join(root, 'lib/studio/public/index.html'))) throw new Error('Studio UI not built: run npm run studio:build first');
  const chrome = findChrome();
  if (!chrome) throw new Error('no Chrome found: set CHROME_BIN');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-docs-shots-'));
  process.env.BRIGHTTEST_LEASE_DIR = path.join(tmp, 'leases');
  process.env.BRIGHTTEST_CACHE = path.join(tmp, 'devices.json');
  const lease = require('../lib/device-lease.js');
  const studio = require('../lib/studio/server.js');
  const { createEventLog } = require('../lib/instrument/events.js');
  const { createStateOps } = require('../lib/instrument/state-ops.js');
  const { createFakeRoku } = require('../test/fixtures/fake-roku/server.js');

  const fake = createFakeRoku({ scenario: 'healthy', ecpPort: 0, installerPort: 0, consolePort: 0, debugPort: 0 });
  const ports = await fake.start();
  process.env.ROKU_ECP_PORT = String(ports.ecpPort);

  // Published app state (what an instrumented app's __bt_agent node carries). Values are made up.
  const layers = {
    global: { user: { tier: 'free', name: 'Demo viewer', token: 'abc' }, theme: 'dark', retries: 3, betaEnabled: false },
    scene: { current: 'HomePanel', focusedItem: 2 },
    registry: { prefs: { autoplay: 'true', language: 'en' } },
  };
  const publish = () => fake.setAgentText(JSON.stringify({ v: 1, seq: 7, snapshot: { layers }, truncated: [] }));
  publish();

  // A scripted hub: queues commands and acks them through received, applied, reflected, patching the published layers.
  const log = createEventLog({ sessionId: 'docs1' });
  const stateOps = createStateOps({ session: 'docs1' });
  let seq = 0;
  const hub = {
    sessionId: 'docs1', hellos: 1, lastHelloAt: Date.now(), log, stateOps, events: new EventEmitter(),
    push(cmd, { ack } = {}) {
      const full = { v: 1, id: `c-${++seq}`, ...cmd, seq, session: 'docs1' };
      stateOps.track(full, { ack, now: Date.now() });
      setTimeout(() => {
        if (full.op === 'set' && full.args.layer && full.args.path) {
          const parts = full.args.path.split('.'); let o = layers[full.args.layer];
          for (const p of parts.slice(0, -1)) o = o[p];
          o[parts[parts.length - 1]] = full.args.value; publish();
        }
        for (const phase of ['received', 'applied', 'reflected']) stateOps.onAck({ id: full.id, seq: full.seq, phase, session: 'docs1', result: full.op === 'snapshot' ? { layers: JSON.parse(JSON.stringify(layers)) } : undefined });
      }, 150);
      return full;
    },
  };
  const rootDir = path.join(tmp, 'project');
  fs.mkdirSync(path.join(rootDir, 'flows'), { recursive: true });
  fs.copyFileSync(path.join(root, 'test/fixtures/fake-roku/flows/fake-smoke.e2e.yaml'), path.join(rootDir, 'flows', 'home-smoke.e2e.yaml'));
  const server = await studio.start({
    host: '127.0.0.1', password: 'fake-password', port: 0, rootDir, flowsDir: path.join(rootDir, 'flows'),
    net: { proxy: {}, hub, events: hub.events, log, redactPaths: ['global.user.name'] },
    leaseOpts: { acquireOpts: { dir: process.env.BRIGHTTEST_LEASE_DIR, timers: false, identity: {} }, tickMs: 50 },
  });
  const base = `http://localhost:${server.address().port}`;

  const procs = [];
  let ws = null;
  const cleanup = () => { try { if (ws) ws.close(); } catch {} for (const p of procs) { try { p.kill('SIGKILL'); } catch {} } try { server.close(); } catch {} try { fake.stop(); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
  const alarm = setTimeout(() => { console.error('docs-screenshots: timed out'); cleanup(); process.exit(1); }, 120000);
  process.on('exit', cleanup);
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(1));

  const chromeProc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', `--user-data-dir=${path.join(tmp, 'chrome')}`, '--remote-debugging-port=0', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
  procs.push(chromeProc);
  const portFile = path.join(tmp, 'chrome', 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  const dtPort = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  let page = null;
  for (let i = 0; i < 50 && !page; i++) { page = (await getJson(`http://127.0.0.1:${dtPort}/json/list`)).find((t) => t.type === 'page'); if (!page) await sleep(100); }
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const waiting = new Map();
  const png64 = placeholderPng().toString('base64');
  ws.onmessage = (m) => { const d = JSON.parse(m.data);
    if (d.method === 'Fetch.requestPaused') { cdp('Fetch.fulfillRequest', { requestId: d.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }], body: png64 }).catch(() => {}); return; } if (d.id && waiting.has(d.id)) { const { r, j } = waiting.get(d.id); waiting.delete(d.id); d.error ? j(new Error(d.error.message)) : r(d.result); } };
  const cdp = (method, params = {}) => new Promise((r, j) => { waiting.set(++id, { r, j }); ws.send(JSON.stringify({ id, method, params })); });
  const js = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + expr); return r.result.value; };
  const until = async (expr, what) => { for (let i = 0; i < 100; i++) { if (await js(expr)) return; await sleep(100); } throw new Error(`timed out waiting for ${what}`); };
  const clickText = (sel, text) => js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);
  const shot = async (name, height = H) => {
    await sleep(400);
    const { data } = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height, scale: 1 } });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, name), Buffer.from(data, 'base64'));
    console.log(`wrote ${path.relative(root, path.join(outDir, name))}`);
  };
  await cdp('Page.enable');
  await cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/screenshot*' }] }); // serve the placeholder frame, not the fake's empty reply
  await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: base });
  await until(`document.querySelector('.rail')`, 'the page');
  await sleep(1500);
  await js(`document.querySelector('button.file').click()`);
  await sleep(500);
  await shot('overview.png');

  // State inspector with an edit. The overview uses the default tile layout; the State shots use a saved tile layout
  // that gives the State tile most of the page (the same localStorage key the Tiles menu writes), so the rows show.
  const T = (id, x, y, w, h, state = 'open') => ({ id, x, y, w, h, state });
  const stateLayout = { v: 1, reg: 1, tiles: [T('state', 0, 0, 8, 34), T('monitor', 8, 0, 4, 8), T('flow', 0, 0, 6, 20, 'hidden'), T('remote', 6, 11, 2, 9, 'hidden'), T('node', 8, 11, 4, 9, 'hidden'), T('tree', 0, 20, 4, 9, 'hidden'), T('selector', 4, 20, 4, 9, 'hidden'), T('actions', 0, 29, 6, 8, 'hidden'), T('network', 6, 29, 6, 8, 'hidden')] };
  await js(`localStorage.setItem('bt.studio.layout.inspect', ${JSON.stringify(JSON.stringify(stateLayout))})`);
  await js(`location.reload()`);
  await until(`document.querySelector('[data-testid="tile-state"]')`, 'the state tile');
  await until(`document.querySelector('button.val.edit')`, 'the state rows');
  await shot('state-inspector.png');
  await js(`[...document.querySelectorAll('[data-testid="state-row"]')].find((r) => r.querySelector('.key') && r.querySelector('.key').textContent.trim() === 'theme').querySelector('button.val').click()`);
  await js(`(() => { const i = document.querySelector('input.ed'); i.value = 'light'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await clickText('button', 'set');
  await until(`[...document.querySelectorAll('.chip')].some((c) => c.textContent.trim() === 'reflected')`, 'the reflected ack chip');
  await clickText('button', 'save');
  await sleep(600);
  await shot('state-edit.png');

  // The device is held elsewhere: Studio lets go of the lease, another session takes it, and an edit is then refused (423).
  const post = (action) => fetch(`${base}/api/lease`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
  await js(`[...document.querySelectorAll('[data-testid="state-row"]')].find((r) => r.querySelector('.key') && r.querySelector('.key').textContent.trim() === 'retries').querySelector('button.val').click()`);
  await post('release');
  const key = `127.0.0.1_p${ports.ecpPort}`;
  const other = await lease.acquire({ dir: process.env.BRIGHTTEST_LEASE_DIR, key, agent: 'e2e-run#1', purpose: 'e2e run', pid: process.pid, waitMs: 0, exitOnLost: false, timers: false, identity: {} });
  await js(`(() => { const i = document.querySelector('input.ed'); i.value = '5'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await clickText('button', 'set');
  await until(`document.querySelector('p.msg.err, p.empty.err')`, 'the refusal or the held banner'); // the held view replaces the panel, so the message may not stay visible
  await sleep(2500);
  await shot('device-held.png');
  try { if (other.release) await other.release(); } catch {}

  // Profile page.
  await post('acquire');
  await js(`location.reload()`);
  await sleep(1200);
  await clickText('.rail button', 'Profile');
  await sleep(500);
  await sleep(1000);
  await shot('profile.png', 800);

  clearTimeout(alarm);
  cleanup();
  process.exit(0);
}
main().catch((e) => { console.error(`docs-screenshots: ${e.message}`); process.exit(1); });
