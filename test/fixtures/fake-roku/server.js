#!/usr/bin/env node
'use strict';
// FX-FAKEROKU: zero-dependency scripted stub Roku (ECP, installer, 8080 console, 8085 log/debug).
//   node test/fixtures/fake-roku/server.js --scenario healthy [--host 127.0.0.1] [--ecp-port 8060]
//        [--installer-port 8090] [--console-port 8080] [--debug-port 8085] [--log requests.jsonl] [--hub http://127.0.0.1:<port>]
// Loopback by default. Port 0 picks a free port. `--list` prints the scenario names.
const http = require('http');
const net = require('net');
const fs = require('fs');
const crypto = require('crypto');
const B = require('./bodies');
const { SCENARIOS } = require('./scenarios');
const { HUB_TOKEN_ENV } = require('../../../lib/instrument/hub');

// FIX-07: fetch through the hub. One GET of this fixed target through the hub (route /bt/<token>/net/;<target>),
// on launch and on a keypress of NETBODY_KEY; the body (cut to NETBODY_MAX) lands in Label `netBody`.
const NETBODY_PATH = '/fixture/netbody';
const NETBODY_TARGET = `http://fixture.invalid${NETBODY_PATH}`;
const NETBODY_KEY = 'Info';
const NETBODY_MAX = 200;
const NETBODY_PLACEHOLDER = 'netbody: pending';
const NETBODY_ERROR = 'netbody: error';
const NETBODY_TIMEOUT_MS = 3000;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const JPG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64'
);

const DEFAULTS = {
  fault: null, ecpMode: 'permissive', developerEnabled: true, unreachable: false, activeApp: 'dev',
  tree: 'small', sgnodes: 'ok', launchBounce: 0, launchStays: false, launch404Count: 0, crashAfterKeys: 0,
  debugOnConnect: 'history', liveLines: false, installerMode: 'ok', deleteFails: false, screenshotOk: true,
  screenshotFormat: 'png', bannerSplit: false,
  softwareVersion: '16.0.4', softwareBuild: '853', modelName: 'Ultra', modelNumber: '0000XX', consoleLatencyMs: 0,
  rooibos: null, lateNodeMs: 0, lateNodeId: 'lateNode', agentText: '', devPassword: 'rokudev-test', coldStallMs: 7000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const XML = { 'Content-Type': 'text/xml; charset="UTF-8"' };
const HTML = { 'Content-Type': 'text/html' };

function createFakeRoku(opts = {}) {
  const { scenario = 'healthy', host = '127.0.0.1', logFile } = opts;
  if (!SCENARIOS[scenario]) throw new Error(`unknown scenario "${scenario}" (known: ${Object.keys(SCENARIOS).join(', ')})`);
  const cfg = { ...DEFAULTS, ...SCENARIOS[scenario] };
  for (const k of Object.keys(DEFAULTS)) if (opts[k] !== undefined) cfg[k] = opts[k];

  const log = [];            // request log (JSONL entries)
  const keypresses = [];     // { kind: keypress|keydown|keyup, key, time }
  const inputs = [];         // POST /input query strings
  const attempts = new Map();
  const faulted = new Set();
  const sockets = new Set();
  const debugSockets = new Set();
  let inFlight = 0;
  const state = {
    fault: cfg.fault, activeApp: cfg.activeApp, agentText: cfg.agentText, focusIndex: 0, bounceLeft: 0, launchedAt: Date.now(),
    keyCount: 0, crashed: false, sideloaded: false, launch404Left: 0, installs: 0, deletes: 0, hadDelete: false,
    debugConnections: 0, perfRunning: false, target: 'dev',
  };
  let installedArchiveBytes = 0;
  let fetchGen = 0;
  if (opts.hub) state.netBody = NETBODY_PLACEHOLDER;

  // One GET through the hub. Never throws, never logs; any failure shows the fixed error string (no token, host or stack).
  function fetchNetBody() {
    if (!opts.hub) return Promise.resolve();
    const gen = ++fetchGen;
    const set = (t) => { if (gen === fetchGen) state.netBody = t; };
    return new Promise((resolve) => {
      let done = false;
      const end = (t) => { if (done) return; done = true; set(t); resolve(); };
      try {
        const token = (opts.env || process.env)[HUB_TOKEN_ENV];
        if (!token) return end(NETBODY_ERROR);
        const base = new URL(opts.hub);
        const req = http.get({
          hostname: base.hostname, port: base.port, path: `/bt/${encodeURIComponent(token)}/net/;${NETBODY_TARGET}`, timeout: NETBODY_TIMEOUT_MS,
        }, (res) => {
          if (res.statusCode !== 200) { res.resume(); return end(NETBODY_ERROR); }
          const chunks = [];
          let size = 0;
          res.on('data', (c) => { if (size < NETBODY_MAX * 4) { chunks.push(c); size += c.length; } });
          res.on('end', () => end(Buffer.concat(chunks).toString('utf8').slice(0, NETBODY_MAX)));
          res.on('error', () => end(NETBODY_ERROR));
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => end(NETBODY_ERROR));
      } catch { end(NETBODY_ERROR); }
    });
  }

  function record(service, req, start, status, attempt, inflightAtStart) {
    const entry = {
      service, method: req.method, endpoint: req.url.split('?')[0], url: req.url, status,
      start: new Date(start).toISOString(), end: new Date().toISOString(), startMs: start, endMs: Date.now(),
      attempt, inFlight: inflightAtStart,
    };
    log.push(entry);
    if (logFile) fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
  }

  function connEvent(service, event) {
    const now = Date.now();
    const entry = { service, event, time: new Date(now).toISOString(), startMs: now, endMs: now };
    log.push(entry);
    if (logFile) fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
  }

  function reply(res, status, body = '', headers = XML) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    res.writeHead(status, { ...headers, 'Content-Length': buf.length });
    res.end(buf);
  }

  const fwInfo = () => ({ softwareVersion: cfg.softwareVersion, softwareBuild: cfg.softwareBuild, modelName: cfg.modelName, modelNumber: cfg.modelNumber });
  const tree = () => B.buildTree(cfg.tree, state.agentText, {
    focusIndex: state.focusIndex, netBody: state.netBody,
    lateNode: cfg.lateNodeMs && Date.now() - state.launchedAt >= cfg.lateNodeMs ? cfg.lateNodeId : null,
  });
  // Path-scoped faults: `path` is exact ('/keypress/Home') or a prefix glob ('/keyup/*').
  const pathMatches = (pat, p) => {
    const want = pat.startsWith('/') ? pat : `/${pat}`;
    return want.endsWith('*') ? p.startsWith(want.slice(0, -1)) : p === want;
  };
  const moveFocus = (key) => {
    if (cfg.tree !== 'grid') return;
    const i = state.focusIndex, col = i % 3;
    if (key === 'Right' && col < 2) state.focusIndex = i + 1;
    else if (key === 'Left' && col > 0) state.focusIndex = i - 1;
    else if (key === 'Down' && i < 3) state.focusIndex = i + 3;
    else if (key === 'Up' && i >= 3) state.focusIndex = i - 3;
  };

  function crash() {
    state.crashed = true;
    state.activeApp = 'roku';
    for (const s of debugSockets) s.write(B.DEBUG_CRASH.join('\r\n'));
  }

  // ---------------- ECP ----------------
  async function ecp(req, res, url) {
    const p = url.pathname;
    const f = state.fault && (!state.fault.path || pathMatches(state.fault.path, p)) ? state.fault : null;
    if (f) {
      const first = !faulted.has(p);
      faulted.add(p);
      if (f.mode === 'slow') await sleep(f.ms || 200);
      else if (!f.once || first) {
        if (f.mode === 'hang') return;
        if (f.mode === 'reset') return req.socket.destroy();
        if (f.mode === 'status') return reply(res, f.status, `HTTP ${f.status}`, { 'Content-Type': 'text/plain' });
      }
    }
    if (cfg.ecpMode === 'limited' && !['/query/device-info', '/query/apps', '/query/active-app'].includes(p)) {
      return reply(res, 403, 'Forbidden: ECP is in limited mode', { 'Content-Type': 'text/plain' });
    }
    if (p === '/query/device-info') return reply(res, 200, B.deviceInfo({ limited: cfg.ecpMode === 'limited', developerEnabled: cfg.developerEnabled, ...fwInfo() }));
    if (p === '/query/apps') return reply(res, 200, B.apps());
    if (p === '/query/active-app') {
      if (state.bounceLeft > 0) { state.bounceLeft--; return reply(res, 200, B.activeApp('roku')); }
      return reply(res, 200, B.activeApp(state.activeApp));
    }
    if (p.startsWith('/query/sgnodes/') || p === '/query/app-ui') return sgnodes(req, res, url);
    let m = p.match(/^\/(keypress|keydown|keyup)\/(.+)$/);
    if (m && req.method === 'POST') {
      const key = decodeURIComponent(m[2]);
      keypresses.push({ kind: m[1], key, time: new Date().toISOString() });
      if (m[1] !== 'keyup') {
        state.keyCount++;
        if (key === NETBODY_KEY) fetchNetBody();
        if (key === 'Home') state.activeApp = 'roku';
        else moveFocus(key);
        if (cfg.crashAfterKeys && !state.crashed && state.keyCount >= cfg.crashAfterKeys) crash();
      }
      return reply(res, 200);
    }
    if (p === '/input' && req.method === 'POST') { inputs.push(url.search.slice(1)); return reply(res, 200); }
    m = p.match(/^\/launch\/(.+)$/);
    if (m && req.method === 'POST') {
      if (!cfg.developerEnabled && m[1] === 'dev') return reply(res, 404, 'Not Found', { 'Content-Type': 'text/plain' });
      if (m[1] === 'dev' && state.launch404Left > 0) { state.launch404Left--; return reply(res, 404, 'Not Found', { 'Content-Type': 'text/plain' }); }
      state.launchedAt = Date.now();
      state.crashed = false;
      fetchNetBody();
      if (m[1] === 'dev' && !cfg.launchStays) { state.activeApp = 'dev'; state.bounceLeft = cfg.launchBounce; }
      return reply(res, 200);
    }
    if (p === '/query/screenshot') return screenshot(res);
    return reply(res, 404, 'Not Found', { 'Content-Type': 'text/plain' });
  }

  async function sgnodes(req, res, url) {
    const p = url.pathname;
    if (state.crashed) return reply(res, 200, B.sgnodesFailed());
    // sgnodes-fails: every /query/sgnodes/* answers FAILED; /query/app-ui still serves the tree (ROB-10 fallback source).
    if (cfg.sgnodes === 'fail' && p !== '/query/app-ui') return reply(res, 200, B.sgnodesFailed());
    // sgnodes-hangs: sgnodes accepts and never answers; /query/app-ui still serves the tree (ROB-10 hang follow-up).
    if (cfg.sgnodes === 'hang-sgnodes' && p !== '/query/app-ui') return;
    if (cfg.sgnodes === 'hang') return;
    if (cfg.sgnodes === 'cold-stall') {
      const wait = state.launchedAt + cfg.coldStallMs - Date.now();
      if (wait > 0) await sleep(wait);
    }
    const root = tree();
    if (p === '/query/sgnodes/all') return reply(res, 200, B.sgnodesAll(root));
    if (p === '/query/sgnodes/roots') return reply(res, 200, B.sgnodesRoots(root));
    if (p === '/query/sgnodes/nodes') return reply(res, 200, B.sgnodesNode(root, url.searchParams.get('node-id')));
    if (p === '/query/app-ui') return reply(res, 200, B.appUi(root, cfg.tree === 'dialog-root'));
    return reply(res, 404, 'Not Found', { 'Content-Type': 'text/plain' });
  }

  function screenshot(res) {
    if (!cfg.screenshotOk) return reply(res, 200, B.installPage('Screenshot not ok'), HTML);
    return cfg.screenshotFormat === 'jpg' ? reply(res, 200, JPG, { 'Content-Type': 'image/jpeg' }) : reply(res, 200, PNG, { 'Content-Type': 'image/png' });
  }

  // ---------------- Installer (port 80 on a real device) ----------------
  function digestOk(req, method) {
    const h = req.headers.authorization || '';
    if (!/^Digest /i.test(h)) return false;
    const a = {};
    for (const mm of h.replace(/^Digest\s+/i, '').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) a[mm[1]] = mm[2] !== undefined ? mm[2] : mm[3];
    if (a.username !== 'rokudev' || a.realm !== 'rokudev') return false;
    const ha1 = md5(`rokudev:rokudev:${cfg.devPassword}`);
    const ha2 = md5(`${method}:${a.uri}`);
    const want = a.qop ? md5(`${ha1}:${a.nonce}:${a.nc}:${a.cnonce}:${a.qop}:${ha2}`) : md5(`${ha1}:${a.nonce}:${ha2}`);
    return want === a.response;
  }

  async function installer(req, res, url, body) {
    if (!cfg.developerEnabled) return reply(res, 404, 'Not Found', { 'Content-Type': 'text/plain' });
    if (!digestOk(req, req.method)) {
      const nonce = crypto.randomBytes(8).toString('hex');
      return reply(res, 401, 'Unauthorized', { 'Content-Type': 'text/plain', 'WWW-Authenticate': `Digest realm="rokudev", nonce="${nonce}", qop="auth", opaque="fake"` });
    }
    const p = url.pathname;
    if (req.method === 'GET' && (p === '/' || p === '/plugin_install')) return reply(res, 200, B.installPage('Fake installer'), HTML);
    if (req.method === 'POST' && p === '/plugin_install') {
      const text = body.toString('latin1');
      const action = (text.match(/name="mysubmit"\r\n\r\n([^\r\n]*)/) || [])[1] || '';
      if (/^delete$/i.test(action)) {
        state.deletes++;
        if (cfg.deleteFails) return reply(res, 200, B.installPage('Delete Failure: unable to remove application.'), HTML);
        state.hadDelete = true;
        state.rooibosLines = null;
        installedArchiveBytes = 0;
        return reply(res, 200, B.installPage('Application Deleted.'), HTML);
      }
      state.installs++;
      const mode = cfg.installerMode;
      if (mode === 'http-500') return reply(res, 500, 'Internal Server Error', { 'Content-Type': 'text/plain' });
      if (mode === 'page') return reply(res, 200, B.installPage('Fake installer page'), HTML);
      if (mode === 'compile-failure') return reply(res, 200, B.installPage('Install Failure: Compilation Failed.'), HTML);
      if (mode === 'transient-once' && !state.hadDelete) return reply(res, 200, B.installPage('Install Failure: Unable to install, please try again.'), HTML);
      installedArchiveBytes = body.length;
      state.sideloaded = true;
      if (cfg.rooibos) { state.rooibosLines = B.rooibosTranscript(cfg.rooibos); for (const ds of debugSockets) ds.write(state.rooibosLines.join('\r\n') + '\r\n'); }
      state.launch404Left = cfg.launch404Count;
      return reply(res, 200, B.installPage('Install Success.'), HTML);
    }
    if (req.method === 'POST' && p === '/plugin_inspect') {
      if (!cfg.screenshotOk) return reply(res, 200, B.installPage('Screenshot not ok'), HTML);
      return reply(res, 200, B.installPage(`Screenshot ok <img src="/pkgs/dev.${cfg.screenshotFormat}">`), HTML);
    }
    const m = p.match(/^\/pkgs\/dev\.(jpg|png)$/);
    if (req.method === 'GET' && m) {
      return m[1] === 'jpg' ? reply(res, 200, JPG, { 'Content-Type': 'image/jpeg' }) : reply(res, 200, PNG, { 'Content-Type': 'image/png' });
    }
    return reply(res, 404, 'Not Found', { 'Content-Type': 'text/plain' });
  }

  function httpServer(service, handler) {
    const server = http.createServer((req, res) => {
      const start = Date.now();
      const attemptKey = `${service} ${req.method} ${req.url.split('?')[0]}`;
      const attempt = (attempts.get(attemptKey) || 0) + 1;
      attempts.set(attemptKey, attempt);
      const atStart = ++inFlight;
      let done = false;
      const finish = () => { if (done) return; done = true; inFlight--; record(service, req, start, res.statusCode && res.headersSent ? res.statusCode : null, attempt, atStart); };
      res.on('close', finish);
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        let url;
        try { url = new URL(req.url, 'http://x'); } catch { return reply(res, 400, 'bad url', { 'Content-Type': 'text/plain' }); }
        try { await handler(req, res, url, Buffer.concat(chunks)); } catch { if (!res.headersSent) reply(res, 500, 'internal', { 'Content-Type': 'text/plain' }); }
      });
    });
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    return server;
  }

  // ---------------- 8080 console ----------------
  function consoleServer() {
    const server = net.createServer((s) => {
      sockets.add(s); s.on('error', () => {});
      connEvent('console', 'connect');
      s.on('close', () => { sockets.delete(s); connEvent('console', 'close'); });
      const banner = B.consoleBanner(fwInfo());
      const lag = () => (cfg.consoleLatencyMs ? sleep(cfg.consoleLatencyMs) : Promise.resolve());
      const send = (t) => { if (!s.destroyed) s.write(t); };
      if (cfg.bannerSplit) {
        const cut = Math.floor(banner.length / 2);
        lag().then(() => { send(banner.slice(0, cut)); setTimeout(() => send(banner.slice(cut)), 30); });
      } else lag().then(() => send(banner));
      let buf = '';
      let chain = Promise.resolve();
      s.on('data', (d) => {
        buf += d.toString('latin1');
        let i;
        while ((i = buf.search(/\r?\n/)) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(buf.indexOf('\n', i) + 1);
          chain = chain.then(lag).then(() => {
            if (s.destroyed) return;
            const out = consoleCommand(line);
            if (out === null) return s.end();
            send(`${out}${out ? '\r\n' : ''}>`);
          });
        }
      });
    });
    return server;
  }

  function consoleCommand(line) {
    const [cmd, ...rest] = line.split(/\s+/);
    const arg = rest.join(' ');
    if (!cmd) return '';
    if (cmd === 'quit' || cmd === 'q' || cmd === 'exit') return null;
    if (cmd === 'help' || cmd === '?') return 'chanperf\r\nhelp\r\nlogrendezvous [on|off]\r\nquit\r\nsgperf [start|stop|clear|report]\r\ntarget [list|<name>]';
    if (cmd === 'target') {
      const names = ['main', 'Native UI', 'Fake Channel'];
      if (arg && arg !== 'list') { if (names.includes(arg)) state.target = arg; else return `target: unknown target "${arg}"`; }
      return names.map((n, i) => `${(arg && arg !== 'list' ? state.target : 'Fake Channel') === n ? '*' : ' '} [${i}] ${n}`).join('\r\n');
    }
    if (cmd === 'sgperf') {
      if (arg === 'start') state.perfRunning = true;
      else if (arg === 'stop') state.perfRunning = false;
      else if (arg === 'report') return B.SGPERF_REPORT;
      return '';
    }
    if (cmd === 'chanperf') return B.CHANPERF;
    if (cmd === 'logrendezvous') return `logrendezvous: rendezvous logging is ${arg === 'on' ? 'on' : 'off'}`;
    return `Unknown command: ${cmd}`;
  }

  // ---------------- 8085 log / debug ----------------
  function debugServer() {
    return net.createServer((s) => {
      sockets.add(s);
      s.on('close', () => { sockets.delete(s); debugSockets.delete(s); connEvent('debug', 'close'); });
      s.on('error', () => {});
      connEvent('debug', 'connect');
      state.debugConnections++;
      debugSockets.add(s);
      const lines = cfg.debugOnConnect === 'crash' ? [...B.DEBUG_HISTORY, ...B.DEBUG_CRASH]
        : cfg.debugOnConnect === 'halted' ? [...B.DEBUG_HISTORY, 'Brightscript Debugger> ']
        : B.DEBUG_HISTORY;
      s.write(lines.join('\r\n') + (cfg.debugOnConnect === 'history' ? '\r\n' : ''));
      if (state.rooibosLines) s.write((cfg.debugOnConnect === 'history' ? '' : '\r\n') + state.rooibosLines.join('\r\n') + '\r\n');
      if (cfg.liveLines) {
        let n = 0;
        const t = setInterval(() => { if (s.destroyed) clearInterval(t); else s.write(`FakeApp: live line ${++n}\r\n`); }, 100);
        s.on('close', () => clearInterval(t));
      }
    });
  }

  const servers = {};
  const ports = {};
  const listen = (server, port) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address().port));
  });

  return {
    scenario, config: cfg, state, log, keypresses, inputs,
    get debugConnections() { return state.debugConnections; },
    setFault(f) { state.fault = f; faulted.clear(); },
    setActiveApp(a) { state.activeApp = a; },
    setAgentText(t) { state.agentText = String(t); },
    // Raw write with no line ending (partial lines).
    emitDebugRaw(text) { for (const s of debugSockets) s.write(String(text)); },
    emitDebug(line) { for (const s of debugSockets) s.write(line + '\r\n'); },
    async start() {
      servers.ecp = httpServer('ecp', ecp);
      servers.installer = httpServer('installer', installer);
      servers.console = consoleServer();
      servers.debug = debugServer();
      const want = {
        ecp: opts.ecpPort ?? 0, installer: opts.installerPort ?? 0, console: opts.consolePort ?? 0, debug: opts.debugPort ?? 0,
      };
      const skip = new Set();
      if (cfg.installerMode === 'tcp80-closed') skip.add('installer');
      if (!cfg.developerEnabled) { skip.add('console'); skip.add('debug'); }
      for (const k of Object.keys(servers)) {
        if (cfg.unreachable || skip.has(k)) {
          // Reserve then release a port so callers get a number that refuses connections.
          const port = await listen(servers[k], want[k]);
          await new Promise((r) => servers[k].close(r));
          ports[k] = port;
        } else ports[k] = await listen(servers[k], want[k]);
      }
      state.launchedAt = Date.now();
      fetchNetBody();
      return {
        host, ecpPort: ports.ecp, installerPort: ports.installer, consolePort: ports.console, debugPort: ports.debug,
        ecpUrl: `http://${host}:${ports.ecp}`, installerUrl: `http://${host}:${ports.installer}`,
      };
    },
    async stop() {
      for (const s of sockets) s.destroy();
      await Promise.all(Object.values(servers).map((s) => new Promise((r) => (s.listening ? s.close(() => r()) : r()))));
    },
  };
}

const VALUE_FLAGS = {
  '--scenario': ['scenario'], '--host': ['host'], '--log': ['logFile'],
  '--ecp-port': ['ecpPort', Number], '--installer-port': ['installerPort', Number],
  '--console-port': ['consolePort', Number], '--debug-port': ['debugPort', Number],
  '--software-version': ['softwareVersion'], '--software-build': ['softwareBuild'], '--model': ['modelName'],
  '--console-latency-ms': ['consoleLatencyMs', Number], '--installer-mode': ['installerMode'],
  '--screenshot-format': ['screenshotFormat'], '--rooibos': ['rooibos'],
  '--fault-path': ['faultPath'], '--fault-status': ['faultStatus', Number],
  '--agent-text': ['agentTextFile'], '--hub': ['hub'],
};
const BOOL_FLAGS = { '--delete-fails': ['deleteFails', true], '--screenshot-not-ok': ['screenshotOk', false], '--banner-split': ['bannerSplit', true] };

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') o.list = true;
    else if (BOOL_FLAGS[a]) o[BOOL_FLAGS[a][0]] = BOOL_FLAGS[a][1];
    else if (VALUE_FLAGS[a]) { const [k, conv] = VALUE_FLAGS[a]; const v = argv[++i]; o[k] = conv ? conv(v) : v; }
  }
  // --fault-path [--fault-status N] -> a path-scoped status fault (default 500).
  if (o.faultPath) o.fault = { mode: 'status', status: o.faultStatus || 500, path: o.faultPath };
  delete o.faultPath; delete o.faultStatus;
  if (o.agentTextFile) { o.agentText = fs.readFileSync(o.agentTextFile, 'utf8'); }
  delete o.agentTextFile;
  return o;
}

if (require.main === module) {
  const o = parseArgs(process.argv.slice(2));
  if (o.list) { console.log(Object.keys(SCENARIOS).join('\n')); process.exit(0); }
  const stub = createFakeRoku({ ecpPort: 8060, installerPort: 8090, consolePort: 8080, debugPort: 8085, ...o });
  stub.start().then((a) => console.log(`fake-roku scenario=${stub.scenario} ${JSON.stringify(a)}`)).catch((e) => { console.error(e.message); process.exit(1); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stub.stop().then(() => process.exit(0)));
}

module.exports = { createFakeRoku, parseArgs, SCENARIOS, DEFAULTS, NETBODY_PATH, NETBODY_TARGET, NETBODY_KEY, NETBODY_MAX, NETBODY_PLACEHOLDER, NETBODY_ERROR };
