'use strict';
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { createEventLog, validateEvent, validateCommand, redact } = require('./events');
const { refuseConnect } = require('./net-proxy');
const { createNetCtl } = require('./net-ctl');
const { createStateOps, StateOpsError, MAX_STATE_BYTES, loggable, checkSize } = require('./state-ops');

// The instrument hub (ADR 0016, design app-state-devtools.md 4.4): a Node-core http server the instrumented
// app dials. Routes live under /bt/<token>/ : hello, cmd (long-poll), events (NDJSON). The network route
// /bt/<token>/net/;<url> is mounted only when `netProxy` (createNetProxy()) is passed; otherwise it answers 404.
// With `netProxy` the spec control API is mounted too: POST /bt/<token>/ctl/net/<op> (NET-N-T6, net-ctl.js; the
// BTNet_* client). Without it, ctl/* answers 404. Only the documented `net/;<url>` form is
// accepted (an empty target or any other net path answers 404). The hub does not own the proxy: close it yourself.
//
// State routes (STA-S-T5, state-ops.js): GET /bt/<token>/state[?id=<cmd id>] reads command status and the last
// state.snapshot; POST /bt/<token>/state queues one state command {op, args, ack?} (202 {id, seq, session}). Bodies over
// 64 KB answer 413 {error:"STATE_TOO_LARGE"}, never truncated. Agent `cmd.ack` events on `events` feed the machine.
//
// Write path (STA-S-T6): the agent long-polls GET /bt/<token>/cmd?after=<seq>&session=<id> (at most one outstanding poll is
// expected; 200 [commands], 204 idle, 409 {resync}) and answers with `cmd.ack` events on POST .../events (phases received,
// applied, reflected). A `restore` command naming a stored snapshot ({name}) is expanded to its layers when queued
// (404 NOT_FOUND for an unknown name); an applied `snapshot` ack with ok:true stores its layers under args.name. An ack
// result over 64 KB is replaced by a typed STATE_TOO_LARGE failure. Open commands time out on a timer, not only on GET.
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
const DEFAULT_HUB_PORT = 8790;
// Quiet commands (internal reads such as Studio's simulator state poll) carry this id prefix: the hub tracks them for
// their ack but never writes cmd.sent or their cmd.ack into the event log or the live stream, so polling cannot evict
// real events from the ring.
const QUIET_PREFIX = 'sr-';

// NET-HUB-PORT: one source for the hub address. `instrument.hub.host` / `instrument.hub.port` are read by both
// `instrument build` (bakes them into BT_config) and `e2e run` (listens on the port, expects the host). Port defaults
// to 8790. Host rule: when unset, the first non-internal IPv4 address of this machine (the device dials the dev
// machine's LAN address); build and run resolve it the same way, and `auto` is never baked.
function lanHost() {
  const nets = require('os').networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const a of nets[name] || []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) return a.address;
  }
  return null;
}
function hubAddress(cfg) {
  const h = cfg && cfg.instrument && cfg.instrument.hub && typeof cfg.instrument.hub === 'object' ? cfg.instrument.hub : {};
  let port = DEFAULT_HUB_PORT;
  if (h.port !== undefined && h.port !== null) {
    port = Number(h.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HubError('USAGE', `instrument.hub.port must be an integer from 1 to 65535 (got ${JSON.stringify(h.port)})`);
  }
  let host = h.host;
  if (host !== undefined && host !== null && (typeof host !== 'string' || !host.trim() || host.trim().toLowerCase() === 'auto')) {
    throw new HubError('USAGE', 'instrument.hub.host must be a host name or IPv4 address (the literal "auto" is not accepted); leave it unset to use this machine\'s LAN address');
  }
  host = typeof host === 'string' ? host.trim() : lanHost();
  return { host, port, hostFromConfig: typeof h.host === 'string' };
}

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

// Test-only switch (inert unless set): a comma list in BRIGHTTEST_TEST_SWITCH, read once by startLanHub from the env it is
// given, or passed as the startHub option `testSwitch`. Nothing in brighttest sets it. Names:
//   net-hello-drop     answer a net hello by closing the socket with no reply (a failed hello, as when the hub is unreachable)
//   net-hello-log      record each net hello (time, peer port, open command count) for the harness: api.testLog
//   net-hello-pending  make sure a command is open when a net hello arrives (queues a ping if none is)
const TEST_SWITCH_ENV = 'BRIGHTTEST_TEST_SWITCH';
const TEST_SWITCH_NAMES = ['net-hello-drop', 'net-hello-log', 'net-hello-pending'];
function parseTestSwitch(v) {
  const list = Array.isArray(v) || v instanceof Set ? [...v] : typeof v === 'string' ? v.split(',') : [];
  return new Set(list.map((x) => String(x).trim()).filter((x) => TEST_SWITCH_NAMES.includes(x)));
}

async function startHub(opts = {}) {
  const {
    host = '127.0.0.1', port = 0, mode = 'headless', lease, sessionDir = null, tokens,
    peerOf = null, devicePeer = null, onPeerRefused = null, longPollMs = LONG_POLL_MS, tickMs = 1000, stateTimeouts = {}, redactPaths = [], buildToken = null, netProxy = null, testSwitch = null,
  } = opts;
  const sw = parseTestSwitch(testSwitch);
  const testLog = [];
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
  let lastHelloAt = null; // ms epoch of the latest counted hello, or null
  let netHellos = 0; // net hellos (?role=net) seen: counted apart, they never resync the agent session
  let lastNetHelloAt = null;
  let hellos = 0; // successful hello handshakes seen (NET-N-T9: e2e fails fast when a build never dials the hub)
  const waiters = new Set(); // pending long-polls: { res, after, timer }
  const stateOps = createStateOps({ session: sessionId, timeouts: stateTimeouts });
  let lastSnapshot = null; // data of the latest agent state.snapshot event
  const snapshotNames = new Map(); // command id -> snapshot name, until its applied ack arrives
  const stats = { cmdPolls: 0, eventPosts: 0, peakWaiters: 0 }; // TP-STA-28: idle agent cost
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

  async function handleState(req, res, u, method, qSession) {
    if (qSession && qSession !== sessionId) return sendJson(res, 409, { resync: true, session: sessionId });
    if (method === 'GET') {
      const timedOut = stateOps.tick(Date.now());
      const id = u.searchParams.get('id');
      if (id) {
        const c = stateOps.get(id);
        return c ? sendJson(res, 200, { session: sessionId, command: c }) : sendJson(res, 404, { error: 'NOT_FOUND', id });
      }
      return sendJson(res, 200, { session: sessionId, commands: stateOps.list(), gaps: stateOps.gaps, timedOut: timedOut.length, snapshot: lastSnapshot });
    }
    // POST: read at most MAX_STATE_BYTES, discard the rest, answer a typed 413 (never truncate, never destroy the socket).
    const declared = Number(req.headers['content-length']);
    const chunks = []; let n = 0, over = declared > MAX_STATE_BYTES;
    await new Promise((resolve, reject) => {
      req.on('data', (c) => { n += c.length; if (n > MAX_STATE_BYTES) over = true; else chunks.push(c); });
      req.on('end', resolve);
      req.on('error', reject);
    });
    if (over) return sendJson(res, 413, { error: 'STATE_TOO_LARGE', limit: MAX_STATE_BYTES });
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return sendJson(res, 400, { error: 'BAD_COMMAND', message: 'body is not valid JSON' }); }
    try {
      if (body && body.op === 'restore' && body.args && typeof body.args === 'object' && typeof body.args.name === 'string' && body.args.layers === undefined) {
        const layers = stateOps.getSnapshot(body.args.name);
        if (!layers) return sendJson(res, 404, { error: 'NOT_FOUND', message: `snapshot not found: ${body.args.name}` });
        body = { ...body, args: { ...body.args, layers } };
      }
      const draft = stateOps.prepare(body);
      const full = api.push({ op: draft.op, args: draft.args, ack: draft.ack }, { ack: draft.ack });
      if (draft.op === 'snapshot' && typeof draft.args.name === 'string' && draft.args.name) { snapshotNames.set(full.id, draft.args.name); if (snapshotNames.size > 500) snapshotNames.delete(snapshotNames.keys().next().value); }
      return sendJson(res, 202, { id: full.id, seq: full.seq, session: sessionId });
    } catch (e) {
      if (e instanceof StateOpsError || e instanceof HubError) return sendJson(res, e.code === 'STATE_TOO_LARGE' ? 413 : 400, { error: e.code, message: e.message });
      throw e;
    }
  }

  // An ack whose result is over the cap becomes a typed failure (never truncated).
  function capAck(ev) {
    if (ev.data.result === undefined) return ev;
    try { checkSize(ev.data.result); return ev; } catch (e) {
      const { result, ...rest } = ev.data;
      return { ...ev, data: { ...rest, ok: false, error: `${e.code}: ${e.message}` } };
    }
  }
  function onAckEvent(ev) {
    const out = stateOps.onAck({ ...ev.data, session: ev.session });
    const name = snapshotNames.get(ev.data.id);
    if (name && ev.data.phase === 'applied') {
      snapshotNames.delete(ev.data.id);
      if (ev.data.ok !== false && !ev.data.error && ev.data.result && ev.data.result.layers && out.kind === 'applied-update') {
        try { stateOps.saveSnapshot(name, ev.data.result.layers, Date.now()); } catch { /* too large or store full: the command still shows its ack */ }
      }
    }
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
      || (route === 'cmd' && method === 'GET') || (route === 'events' && method === 'POST')
      || (route === 'state' && (method === 'GET' || method === 'POST'));
    if (!routeOk) return refuse(res, 404);
    if (leaseLost()) return refuse(res, 423);

    const qSession = u.searchParams.get('session');
    if (route === 'state') return handleState(req, res, u, method, qSession);
    if (route === 'hello') {
      if (u.searchParams.get('role') === 'net') {
        // A net hello (one per app thread) only asks for the net prefix; it must not touch the agent's session.
        netHellos++;
        lastNetHelloAt = Date.now();
        if (sw.size) {
          const open = () => stateOps.list().filter((c) => c.status === 'pending').length;
          if (sw.has('net-hello-pending') && open() === 0) api.push({ op: 'ping', args: {}, ack: 'applied' }, { ack: 'applied' });
          if (sw.has('net-hello-log')) testLog.push({ at: lastNetHelloAt, peerPort: req.socket.remotePort, open: open() });
          if (sw.has('net-hello-drop')) { req.socket.destroy(); return undefined; }
        }
        return sendJson(res, 200, { session: sessionId, seq: cmdSeq, active: true, netBase: `/bt/${segs[2]}/net/;`, caps: {} });
      }
      hellos++;
      lastHelloAt = Date.now();
      // A (re)started agent must not replay commands queued before it connected: `seq` is the newest command now, and the
      // agent polls from it. Commands still open from an earlier agent connection are abandoned, so a late ack for one
      // of them cannot land in this connection's session.
      stateOps.resync();
      return sendJson(res, 200, { session: sessionId, seq: cmdSeq, active: true, netBase: `/bt/${segs[2]}/net/;`, caps: {} });
    }
    if (route === 'cmd') {
      if (qSession && qSession !== sessionId) return sendJson(res, 409, { resync: true, session: sessionId });
      const after = Number(u.searchParams.get('after')) || 0;
      const out = commands.filter((c) => c.seq > after);
      if (out.length) return sendJson(res, 200, out);
      stats.cmdPolls++;
      const w = { res, after, timer: null };
      w.timer = setTimeout(() => finishWait(w, () => { res.writeHead(204); res.end(); }), longPollMs);
      waiters.add(w);
      if (waiters.size > stats.peakWaiters) stats.peakWaiters = waiters.size;
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
    stats.eventPosts++;
    let accepted = 0, rejected = 0, stale = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch (e) { rejected++; continue; }
      if (validateEvent(ev)) { rejected++; continue; }
      if (ev.session && ev.session !== sessionId) { stale++; continue; }
      if (ev.kind === 'cmd.ack' && ev.data) ev = capAck(ev);
      const quiet = ev.kind === 'cmd.ack' && ev.data && typeof ev.data.id === 'string' && ev.data.id.startsWith(QUIET_PREFIX);
      const stored = quiet ? null : log.push({ src: 'agent', ...ev });
      if (ev.kind === 'cmd.ack' && ev.data) onAckEvent(ev);
      if (ev.kind === 'state.snapshot' && ev.data) lastSnapshot = redact(ev.data, redactPaths);
      accepted++;
      if (stored) emitter.emit('event', stored);
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

  const timer = setInterval(() => {
    if (stopped || leaseLost()) return;
    for (const c of stateOps.tick(Date.now())) {
      const stored = log.push({ src: 'hub', kind: 'cmd.timeout', data: { id: c.id, seq: c.seq, op: c.op, error: c.error } });
      emitter.emit('event', stored);
    }
  }, tickMs);
  timer.unref();

  const api = {
    host,
    port: server.address().port,
    sessionId,
    get hellos() { return hellos; },
    get stats() { return { ...stats, waiters: waiters.size }; },
    get lastHelloAt() { return lastHelloAt; },
    get netHellos() { return netHellos; },
    get testLog() { return testLog.map((e) => ({ ...e })); },
    get lastNetHelloAt() { return lastNetHelloAt; },
    events: emitter,
    log,
    // Queue a command for the agent; returns it with its seq and the session filled in.
    // `quiet: true` (a read, not an action) gives the command a `sr-` id and keeps it out of the event log and stream.
    push(cmd, { ack, quiet = false } = {}) {
      const bad = validateCommand(cmd);
      if (bad) throw new HubError('BAD_COMMAND', bad);
      const full = { v: 1, ...cmd, id: quiet ? `${QUIET_PREFIX}${cmdSeq + 1}` : cmd.id || `c-${cmdSeq + 1}`, seq: ++cmdSeq, session: sessionId };
      if (ack) {
        stateOps.track(full, { ack, now: Date.now() });
        if (!quiet) {
          const stored = log.push({ src: 'hub', kind: 'cmd.sent', data: loggable(full, redactPaths) });
          emitter.emit('event', stored);
        }
      }
      commands.push(full);
      if (commands.length > MAX_COMMANDS) commands.splice(0, commands.length - MAX_COMMANDS);
      flushWaiters();
      return full;
    },
    // Host-side event (STUDIO-HUB-WIRE): the process that owns the hub writes an event into its own log, e.g. the
    // net proxy's emit, and live streams see it like an agent event. No wire or auth change.
    emitLocal(kind, data) {
      const stored = log.push({ src: 'hub', kind, data });
      emitter.emit('event', stored);
      return stored;
    },
    stateOps,
    markLeaseLost,
    stop() {
      if (stopped) return Promise.resolve();
      stopped = true;
      clearInterval(timer);
      for (const w of [...waiters]) finishWait(w, () => { w.res.writeHead(204); w.res.end(); });
      return new Promise((resolve) => {
        server.close(() => resolve());
        if (server.closeAllConnections) server.closeAllConnections();
      });
    },
  };
  return api;
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
  if (rest.testSwitch === undefined) rest.testSwitch = (rest.env || process.env)[TEST_SWITCH_ENV];
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

module.exports = { hubAddress, lanHost, DEFAULT_HUB_PORT, startHub, startLanHub, hubLease, sse, localLease, deriveSession, HubError, LONG_POLL_MS, QUIET_PREFIX, HUB_TOKEN_ENV, hubTokenFromEnv };
