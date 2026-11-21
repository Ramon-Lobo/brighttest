'use strict';
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { createEventLog, validateEvent, validateCommand } = require('./events');
const { refuseConnect } = require('./net-proxy');
const { createNetCtl } = require('./net-ctl');

// The instrument hub (ADR 0016, design app-state-devtools.md 4.4): a Node-core http server the instrumented
// app dials. Routes live under /bt/<token>/ : hello, cmd (long-poll), events (NDJSON). The network route
// /bt/<token>/net/;<url> is mounted only when `netProxy` (createNetProxy()) is passed; otherwise it answers 404.
// With `netProxy` the spec control API is mounted too: POST /bt/<token>/ctl/net/<op> (NET-N-T6, net-ctl.js; the
// BTNet_* client). Without it, ctl/* answers 404. Only the documented `net/;<url>` form is
// accepted (an empty target or any other net path answers 404). The hub does not own the proxy: close it yourself.
//
// Refusals: a wrong peer, a wrong token or an unknown route answer `404` with no body (no oracle, no echo).
// A lost lease answers `423` on every route (after peer and token pass). A session mismatch answers
// `409 {resync}`. The hub runs in-process: never spawnSync a child that talks to it.
//
// Lease injection point: `lease` is any object { held(): boolean, onLost(cb): void, leaseId?: string }.
// Headless runs use localLease() (always held). startHub throws when held() is false at start.

const LONG_POLL_MS = 25000;
const MAX_BODY = 1024 * 1024;
const MAX_COMMANDS = 2000;

class HubError extends Error {
  constructor(code, message) { super(message); this.name = 'HubError'; this.code = code; }
}

function localLease() {
  return { held: () => true, onLost() {}, leaseId: 'local' };
}

function stripV6(addr) { return String(addr || '').replace(/^::ffff:/i, ''); }
function isLoopback(addr) { return /^127\./.test(addr) || addr === '::1'; }
function isRfc1918(addr) {
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(addr);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function tokenEq(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(buf) {
  let bits = 0, val = 0, out = '';
  for (const byte of buf) {
    val = (val << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

// session = base32(hmac(buildToken, leaseId))[0..16]
function deriveSession(buildToken, leaseId) {
  return base32(crypto.createHmac('sha256', String(buildToken)).update(String(leaseId)).digest()).slice(0, 16);
}

function refuse(res, status) {
  res.writeHead(status, { 'content-length': '0' });
  res.end();
}
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new HubError('TOO_LARGE', 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function startHub(opts = {}) {
  const {
    host = '127.0.0.1', port = 0, mode = 'headless', lease, sessionDir = null, tokens,
    peerOf = null, devicePeer = null, onPeerRefused = null, longPollMs = LONG_POLL_MS, redactPaths = [], buildToken = null, netProxy = null,
  } = opts;
  if (mode !== 'headless' && mode !== 'device') throw new HubError('USAGE', 'startHub: mode must be "headless" or "device"');
  if (!Array.isArray(tokens) || tokens.length === 0 || tokens.some((t) => typeof t !== 'string' || !t)) {
    throw new HubError('USAGE', 'startHub: tokens must be a non-empty array of strings');
  }
  if (!lease || typeof lease.held !== 'function') throw new HubError('USAGE', 'startHub: lease { held, onLost } is required');
  if (mode === 'device' && !devicePeer) throw new HubError('USAGE', 'startHub: device mode needs devicePeer (the leased device IP)');
  if (netProxy && typeof netProxy.handle !== 'function') throw new HubError('USAGE', 'startHub: netProxy must have handle(req, res, target)');
  if (!lease.held()) throw new HubError('LEASE_LOST', 'startHub: the device lease is not held; refusing to listen');

  const leaseId = lease.leaseId || crypto.randomBytes(12).toString('hex');
  const sessionId = deriveSession(buildToken || tokens[0], leaseId);
  const log = createEventLog({ sessionId, sessionDir, redactPaths });
  const emitter = new EventEmitter();
  const commands = [];
  let cmdSeq = 0;
  let lost = false;
  let stopped = false;
  let hellos = 0; // successful hello handshakes seen (NET-N-T9: e2e fails fast when a build never dials the hub)
  const waiters = new Set(); // pending long-polls: { res, after, timer }
  const netCtl = netProxy && netProxy.ruleSet ? createNetCtl({ proxy: netProxy }) : null;

  function leaseLost() { return lost || !lease.held(); }
  function markLeaseLost() {
    if (lost) return;
    lost = true;
    for (const w of [...waiters]) finishWait(w, () => refuse(w.res, 423));
  }
  if (typeof lease.onLost === 'function') lease.onLost(markLeaseLost);

  function finishWait(w, fn) {
    if (!waiters.delete(w)) return;
    clearTimeout(w.timer);
    fn();
  }
  function flushWaiters() {
    for (const w of [...waiters]) {
      const out = commands.filter((c) => c.seq > w.after);
      if (out.length) finishWait(w, () => sendJson(w.res, 200, out));
    }
  }

  function peerAllowed(req) {
    const peer = stripV6(peerOf ? peerOf(req) : req.socket.remoteAddress);
    if (mode === 'headless') return isLoopback(peer);
    return peer === stripV6(devicePeer) && isRfc1918(peer);
  }

  async function handle(req, res) {
    if (!peerAllowed(req)) {
      // The wire answer stays a bare 404 (no oracle). The operator hears about it through the hook; no hub state changes.
      if (typeof onPeerRefused === 'function') {
        try { onPeerRefused({ peer: stripV6(peerOf ? peerOf(req) : req.socket.remoteAddress), expected: mode === 'device' ? stripV6(devicePeer) : 'loopback' }); } catch { /* a hook must not break the hub */ }
      }
      return refuse(res, 404);
    }
    const netHit = /^\/bt\/([^/?#]+)\/net\/;/.exec(req.url);
    if (netHit) {
      // The target (everything after `net/;`, query included) is taken from the raw url, not the parsed path.
      const target = req.url.slice(netHit[0].length);
      if (!netProxy || !target || !tokens.some((t) => tokenEq(t, netHit[1]))) return refuse(res, 404);
      if (leaseLost()) return refuse(res, 423);
      await netProxy.handle(req, res, target);
      return undefined;
    }
    const ctlHit = /^\/bt\/([^/?#]+)\/ctl\/net\/([a-z]+)$/.exec(req.url.split('?')[0]);
    if (ctlHit) {
      if (!netCtl || req.method !== 'POST' || !tokens.some((t) => tokenEq(t, ctlHit[1]))) return refuse(res, 404);
      if (leaseLost()) return refuse(res, 423);
      let text;
      try { text = await readBody(req, MAX_BODY); } catch (e) {
        if (!res.destroyed && !res.headersSent) refuse(res, 413);
        return undefined;
      }
      const out = netCtl.handle(ctlHit[2], text);
      return sendJson(res, out.status, out.json);
    }
    const u = new URL(req.url, 'http://hub');
    const segs = u.pathname.split('/'); // ['', 'bt', token, route, ...]
    if (segs[1] !== 'bt' || segs.length !== 4 || !tokens.some((t) => tokenEq(t, segs[2]))) return refuse(res, 404);
    const route = segs[3];
    const method = req.method;
    const routeOk = (route === 'hello' && (method === 'GET' || method === 'POST'))
      || (route === 'cmd' && method === 'GET') || (route === 'events' && method === 'POST');
    if (!routeOk) return refuse(res, 404);
    if (leaseLost()) return refuse(res, 423);

    const qSession = u.searchParams.get('session');
    if (route === 'hello') {
      hellos++;
      return sendJson(res, 200, { session: sessionId, active: true, netBase: `/bt/${segs[2]}/net/;`, caps: {} });
    }
    if (route === 'cmd') {
      if (qSession && qSession !== sessionId) return sendJson(res, 409, { resync: true, session: sessionId });
      const after = Number(u.searchParams.get('after')) || 0;
      const out = commands.filter((c) => c.seq > after);
      if (out.length) return sendJson(res, 200, out);
      const w = { res, after, timer: null };
      w.timer = setTimeout(() => finishWait(w, () => { res.writeHead(204); res.end(); }), longPollMs);
      waiters.add(w);
      res.on('close', () => finishWait(w, () => {}));
      return undefined;
    }
    // events
    if (qSession && qSession !== sessionId) return sendJson(res, 409, { resync: true, session: sessionId });
    let text;
    try { text = await readBody(req, MAX_BODY); } catch (e) {
      if (!res.destroyed && !res.headersSent) refuse(res, 413);
      return undefined;
    }
    let accepted = 0, rejected = 0, stale = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch (e) { rejected++; continue; }
      if (validateEvent(ev)) { rejected++; continue; }
      if (ev.session && ev.session !== sessionId) { stale++; continue; }
      const stored = log.push({ src: 'agent', ...ev });
      accepted++;
      emitter.emit('event', stored);
    }
    if (stale > 0 && accepted === 0) return sendJson(res, 409, { resync: true, session: sessionId });
    return sendJson(res, 200, { accepted, rejected: rejected + stale });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => { if (!res.headersSent) refuse(res, 404); else res.destroy(); });
  });
  if (netProxy) server.on('connect', refuseConnect);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  return {
    host,
    port: server.address().port,
    sessionId,
    get hellos() { return hellos; },
    events: emitter,
    log,
    // Queue a command for the agent; returns it with its seq and the session filled in.
    push(cmd) {
      const bad = validateCommand(cmd);
      if (bad) throw new HubError('BAD_COMMAND', bad);
      const full = { v: 1, id: cmd.id || `c-${cmdSeq + 1}`, ...cmd, seq: ++cmdSeq, session: sessionId };
      commands.push(full);
      if (commands.length > MAX_COMMANDS) commands.splice(0, commands.length - MAX_COMMANDS);
      flushWaiters();
      return full;
    },
    markLeaseLost,
    stop() {
      if (stopped) return Promise.resolve();
      stopped = true;
      for (const w of [...waiters]) finishWait(w, () => { w.res.writeHead(204); w.res.end(); });
      return new Promise((resolve) => {
        server.close(() => resolve());
        if (server.closeAllConnections) server.closeAllConnections();
      });
    },
  };
}

// ---- LAN hub under the device lease (NET-N-T8) ----------------------------------------------------------------

// Adapt a device-lease object (lib/device-lease.js: { lost, expired, onLost, onExpire }) to the hub's { held, onLost }.
// Existing onLost/onExpire handlers keep running (they were set at acquire time); ours is chained after them.
function hubLease(l) {
  const subs = [];
  const fire = (why) => { for (const cb of subs.splice(0)) { try { cb(why); } catch { /* best-effort */ } } };
  const prevLost = l.onLost, prevExpire = l.onExpire;
  l.onLost = (...a) => { try { if (prevLost) prevLost(...a); } finally { fire(a[0] || 'lost'); } };
  l.onExpire = (...a) => { try { if (prevExpire) prevExpire(...a); } finally { fire('expired'); } };
  return { held: () => !l.lost && !l.expired && !l.released, onLost: (cb) => { subs.push(cb); }, leaseId: l.leaseId };
}

// NET-WIRE: one operator-supplied hub token for the build and the run. `instrument build --net` bakes the value of
// this variable; startLanHub accepts it in addition to the run's own tokens, so a `--net --sideload` build can talk to
// the hub the e2e run started. Never an argv value (process lists), never logged.
const HUB_TOKEN_ENV = 'BRIGHTTEST_HUB_TOKEN';
const HUB_TOKEN_RE = /^[0-9a-f]{32}$/;
function hubTokenFromEnv(env = process.env) {
  const v = env[HUB_TOKEN_ENV];
  return typeof v === 'string' && HUB_TOKEN_RE.test(v) ? v : null;
}

const lanHubs = new Map(); // device host -> running LAN hub (one device session per host in this process)

// Start the LAN hub for `deviceHost` while `lease` is held. Throws LEASE_LOST when it is not held (no listener is
// opened) and PEER_LOCKED when a hub for this host is already running. The hub binds `bindHost` (default all
// interfaces: the device dials the dev machine's LAN address) and answers only the device IP. It stops itself when the
// lease is lost; the caller stops it before releasing the lease.
async function startLanHub({ deviceHost, lease, bindHost = '0.0.0.0', port = 0, tokens, log = () => {}, ...rest } = {}) {
  if (!deviceHost) throw new HubError('USAGE', 'startLanHub: deviceHost is required');
  if (!lease) throw new HubError('USAGE', 'startLanHub: lease is required');
  if (lanHubs.has(deviceHost)) {
    throw new HubError('PEER_LOCKED', `the instrument hub for ${deviceHost} is already held by another session in this process; refusing a second peer`);
  }
  const adapter = typeof lease.held === 'function' ? lease : hubLease(lease);
  const envToken = hubTokenFromEnv(rest.env || process.env);
  if (Array.isArray(tokens) && envToken && !tokens.includes(envToken)) tokens = [...tokens, envToken];
  delete rest.env;
  const seen = new Set();
  const hub = await startHub({
    ...rest, host: bindHost, port, mode: 'device', devicePeer: deviceHost, lease: adapter, tokens,
    onPeerRefused: ({ peer, expected }) => {
      if (seen.has(peer)) return; // one line per peer
      seen.add(peer);
      log(`[brighttest hub] refused a request from ${peer}: the hub for ${deviceHost} answers only that device (expected ${expected})`);
    },
  });
  lanHubs.set(deviceHost, hub);
  const stop = hub.stop;
  hub.stop = () => { if (lanHubs.get(deviceHost) === hub) lanHubs.delete(deviceHost); return stop(); };
  adapter.onLost(() => { hub.markLeaseLost(); hub.stop(); });
  return hub;
}

// Minimal server-sent events writer (NET-N-T8). `sse(res)` sends the event-stream headers and returns
// { send(data, event?), comment(text), close() }. Objects are JSON-encoded; multi-line strings become several `data:` lines.
// No retries, ids or buffering: the caller owns the stream's lifetime (`res` 'close' is the disconnect signal).
function sse(res, { retryMs = null } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  let open = true;
  res.on('close', () => { open = false; });
  const write = (chunk) => { if (open && !res.writableEnded && !res.destroyed) res.write(chunk); };
  if (retryMs != null) write(`retry: ${Math.max(0, Math.floor(retryMs))}\n\n`);
  return {
    send(data, event) {
      const text = typeof data === 'string' ? data : JSON.stringify(data);
      const name = event ? `event: ${String(event).replace(/[\r\n]/g, ' ')}\n` : '';
      write(name + text.split(/\r?\n/).map((l) => `data: ${l}\n`).join('') + '\n');
    },
    comment(t) { write(`: ${String(t).replace(/[\r\n]/g, ' ')}\n\n`); },
    close() { if (open) { open = false; res.end(); } },
    get open() { return open; },
  };
}

module.exports = { startHub, startLanHub, hubLease, sse, localLease, deriveSession, HubError, LONG_POLL_MS, HUB_TOKEN_ENV, hubTokenFromEnv };
