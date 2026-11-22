'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createDevice, queueKey } = require('../e2e/ecp');
const { defaultQueue } = require('../e2e/ecpq');
const devices = require('../devices');
const sg = require('../e2e/sgnodes');
const appstate = require('../e2e/appstate');
const flowLib = require('../e2e/flow');
const { execStep, guardDevice } = require('../e2e/run');
const coords = require('./coords');
const perf = require('./perf');
const bsprof = require('./bsprof');
const sgdebug = require('./sgdebug');
const { PerfettoCapture } = require('./perfetto');
const perfettoState = require('./perfetto-state');
const { summarizeIsolated, createPool: createSummaryPool } = require('./perfetto-summary-run');
const { StudioLease } = require('./lease');
const { sse, hubAddress, hubTokenFromEnv, HUB_TOKEN_ENV, startLanHub } = require('../instrument/hub');
const { createNetProxy } = require('../instrument/net-proxy');
const { redactEvent, redact: redactData } = require('../instrument/events');
const stateSteps = require('../e2e/state-steps');
const { diffLayers } = require('../instrument/state-ops');
const netRules = require('../instrument/net-rules');
const { createNetCtl } = require('../instrument/net-ctl');

// Read-only view of the agent snapshot (__bt_agent) for the AppState panel: { present, seq, error, layers:
// { <name>: { state, truncated: [entries] } }, truncated: [all entries] }. The agent records every cut as
// "<layer>.<path>:<kind>" (or "*:bytes"); each layer gets its own entries so the panel marks them instead of
// showing a silently shortened value. An over-limit document is reported as an error, never cut here.
function agentLayers(roots) {
  let a;
  try { a = appstate.extractAgentState(roots); }
  catch (e) { return { present: true, seq: null, error: e.message, code: e.code || null, layers: {}, truncated: [] }; }
  const layers = {};
  for (const [name, state] of Object.entries(a.layers)) {
    const mine = a.truncated.filter((t) => typeof t === 'string' && (t.startsWith(name + '.') || t.startsWith(name + ':')));
    layers[name] = { state, truncated: mine };
  }
  return { present: a.present, seq: a.seq, error: a.error, layers, truncated: a.truncated };
}

// brighttest studio — local web app that mirrors a running Roku (screenshot + resolved sgnodes overlay).
// Phase 0/1: visualize. A tiny zero-dep Node server serving static files + a JSON API over the e2e driver.
// ECP hits the device's single render thread, so all device reads go through one serialized queue.

const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

// Coalesce a read: while one call is in flight, every caller shares that same promise instead of queuing
// another device round-trip. This keeps the near-instant tree and the slow (~1.1s) screenshot on
// INDEPENDENT lanes — the tree never waits behind a screenshot — while preventing either from stacking up
// under rapid polling. (The two lanes can hit the render thread concurrently; sgnodes already retries.)
function coalesce(fn) {
  let inflight = null;
  return () => {
    if (inflight) return inflight;
    inflight = Promise.resolve().then(fn).finally(() => { inflight = null; });
    return inflight;
  };
}

// Errors the tree read can raise while the render thread is busy or the device is briefly unreachable.
// These are retryable, so /api/tree answers them with the last good tree (stale) or 503, never 502.
const TRANSIENT_TREE_CODES = new Set(['RPC_TIMEOUT', 'SGNODES_FAILED', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED',
  'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT']);
function isTransientTreeError(e) {
  if (!e) return false;
  if (TRANSIENT_TREE_CODES.has(e.code) || (e.cause && TRANSIENT_TREE_CODES.has(e.cause.code))) return true;
  return e.name === 'TimeoutError' || e.name === 'AbortError'; // fetch AbortSignal.timeout from ecpGet
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

// Read a raw (binary) request body with a hard size cap — used for .bsprof imports.
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error(`body exceeds ${maxBytes} bytes`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---- Network panel (NET-N-T10; design network-interception.md 4.8) ----------------------------------------------
// `opts.net` = { proxy, events?, log?, redact?, redactPaths?, version? }: the hub's net proxy (createNetProxy) plus the
// hub's event bus and log (hub.events emits 'event', hub.log.since(seq)). Without `opts.net` Studio starts the hub
// itself while it holds the device lease (see studioHub below); with no hub every /api/net/* and /api/bt/stream route
// answers 503 NO_HUB. Every route needs the device lease (423
// otherwise, like the other device routes) and every payload is redacted with the same redactor the HAR writer uses;
// only GET /api/net/requests?raw=1 returns raw values (the panel's "show secrets" toggle). Hub tokens never appear here.
const NET_LIST_MAX = 500;          // newest entries returned by /api/net/requests
const NET_BODY_MAX = 64 * 1024;    // request body shown per entry
const NET_MOCK_BODY_MAX = 256 * 1024; // largest response body "Mock this" will inline into a rule
const NET_HAR_MAX_BYTES = 16 * 1024 * 1024; // response bodies in one HAR export; older entries are dropped past this
const NET_STREAMS_MAX = 8;
const NET_RULE_BODY_MAX = 256 * 1024;

function netHostPath(u) {
  try { const x = new URL(u); return { host: x.host, path: x.pathname + x.search }; } catch { return { host: '', path: String(u) }; }
}
const ctOf = (h) => { for (const k of Object.keys(h || {})) if (k.toLowerCase() === 'content-type') return String(h[k]); return ''; };

// Rule JSON for "Mock this": the captured response of a completed exchange, redacted. Query values the redactor
// replaced become `*` so the rule still matches; only content-type is kept as a header.
function mockRuleFor(ex, red) {
  const bodyBuf = ex.resBody();
  if (bodyBuf && bodyBuf.length > NET_MOCK_BODY_MAX) {
    const e = new Error(`response body is ${bodyBuf.length} bytes (limit ${NET_MOCK_BODY_MAX}); export the HAR and use net convert`); e.code = 'TOO_LARGE'; throw e;
  }
  let url = ex.url;
  const red1 = red.url(url);
  if (red1 !== url) {
    const q = red1.indexOf('?');
    if (q >= 0) {
      const hash = red1.indexOf('#');
      const qs = red1.slice(q + 1, hash < 0 ? undefined : hash).split('&').map((pair) => (/(^|=)(%3Credacted|<redacted)/i.test(pair) ? `${pair.slice(0, pair.indexOf('='))}=*` : pair)).join('&');
      url = red1.slice(0, q + 1) + qs;
    } else url = red1;
  }
  const rule = { method: ex.method, url, status: ex.status };
  const ct = ctOf(ex.resHeaders);
  if (ct) rule.headers = { 'content-type': ct };
  if (bodyBuf && bodyBuf.length) {
    const isText = !bodyBuf.includes(0);
    if (!isText) rule.bodyBase64 = bodyBuf.toString('base64');
    else {
      const text = red.responseBody(bodyBuf.toString('utf8'), ct);
      let parsed; let isJson = false;
      if (/(^|[/+])json\b/i.test(ct)) { try { parsed = JSON.parse(text); isJson = true; } catch { /* keep as text */ } }
      if (isJson) rule.json = parsed; else rule.body = text;
    }
  }
  return rule;
}

// Returns true when the request was a net/stream route (answered here), false to fall through.
async function handleNet(p, req, res, url, net, gate, streams, hubCtl = null) {
  const isStream = p === '/api/bt/stream';
  if (!isStream && !(p === '/api/net' || p.startsWith('/api/net/'))) return false;
  const known = { '/api/bt/stream': ['GET'], '/api/net/requests': ['GET'], '/api/net/mock-this': ['GET'], '/api/net/har': ['GET'], '/api/net/rules': ['GET', 'POST', 'DELETE'] }[p];
  if (!known) { sendJson(res, 404, { error: `unknown route ${p}`, code: 'NOT_FOUND' }); return true; }
  if (!known.includes(req.method)) { res.writeHead(405, { Allow: known.join(', '), 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'method not allowed', code: 'METHOD' })); return true; }
  if ((!net || !net.proxy) && hubCtl) {
    // Studio's own hub exists only while Studio holds the lease: take it (a poll acquires like any other), then wait for the hub.
    if (!(await gate(false))) return true;
    await hubCtl.ready();
    net = hubCtl.net();
  }
  if (!net || !net.proxy) { sendJson(res, 503, { error: (hubCtl && hubCtl.message()) || 'no instrument hub is running in Studio; start one with the net lane (see docs/e2e/network.md)', code: 'NO_HUB' }); return true; }
  const write = req.method !== 'GET';
  if (!(await gate(write))) return true;
  const proxy = net.proxy;
  const red = netRules.makeRedactor({ ...(net.redact || {}) });
  const q = url.searchParams;

  if (isStream) {
    if (streams.size >= NET_STREAMS_MAX) { sendJson(res, 429, { error: 'too many open streams', code: 'BUSY' }); return true; }
    const after = Number(q.get('after')) || 0;
    const out = sse(res, { retryMs: 3000 });
    const paths = net.redactPaths || [];
    const push = (ev) => out.send(redactEvent(ev, paths));
    const live = [];
    let replaying = true;
    const onEvent = (ev) => { if (replaying) live.push(ev); else push(ev); };
    if (net.events) net.events.on('event', onEvent);
    let lastSeq = after;
    if (net.log) for (const ev of net.log.since(after)) { push(ev); lastSeq = Math.max(lastSeq, ev.seq || 0); }
    replaying = false;
    for (const ev of live) if (!(ev.seq <= lastSeq)) push(ev);
    out.comment('ready');
    const beat = setInterval(() => out.comment('hb'), 15000);
    const stop = () => { clearInterval(beat); streams.delete(stop); if (net.events) net.events.removeListener('event', onEvent); out.close(); };
    streams.add(stop);
    res.on('close', stop);
    return true;
  }

  if (p === '/api/net/requests') {
    const raw = q.get('raw') === '1';
    const limit = Math.max(1, Math.min(NET_LIST_MAX, Number(q.get('limit')) || NET_LIST_MAX));
    const sizes = new Map(proxy.exchanges().map((e) => [e.id, e.resBytes]));
    const all = proxy.requests();
    const list = all.slice(-limit).map((e) => {
      const ct = ctOf(e.headers);
      const body = e.body.length > NET_BODY_MAX ? e.body.slice(0, NET_BODY_MAX) : e.body;
      return {
        id: e.id, method: e.method, ...netHostPath(raw ? e.url : red.url(e.url)), url: raw ? e.url : red.url(e.url),
        status: e.status, ms: e.ms, source: e.source, rule: e.rule, error: e.error, bytes: sizes.has(e.id) ? sizes.get(e.id) : null,
        headers: raw ? e.headers : red.headers(e.headers), body: raw ? body : red.body(body, ct), bodyTruncated: e.body.length > NET_BODY_MAX,
      };
    });
    // hellos / lastHelloAt: whether the app ever dialled the hub (null when the hub reports none). No token here.
    const hello = typeof net.hello === 'function' ? net.hello() : null;
    sendJson(res, 200, { raw, total: all.length, hellos: hello ? hello.hellos : null, lastHelloAt: hello ? hello.lastHelloAt : null, requests: list });
    return true;
  }

  if (p === '/api/net/mock-this') {
    const id = q.get('id');
    const ex = id ? proxy.exchanges({ id })[0] : null;
    if (!ex) { sendJson(res, 404, { error: `no completed request ${id || '(missing id)'} in the log`, code: 'NOT_FOUND' }); return true; }
    try {
      const rule = mockRuleFor(ex, red);
      netRules.createRuleSet().add({ ...rule }); // fail here, not later in the flow
      sendJson(res, 200, { rule, step: `- mockHttp: ${JSON.stringify(rule)}` });
    } catch (e) {
      sendJson(res, e.code === 'TOO_LARGE' ? 413 : 400, { error: e.message, code: e.code || 'BAD_RULE' });
    }
    return true;
  }

  if (p === '/api/net/har') {
    const all = proxy.exchanges();
    const picked = []; let bytes = 0; let truncated = false;
    for (let i = all.length - 1; i >= 0; i--) { // newest first until the budget is spent
      const ex = all[i];
      if (bytes + ex.resBytes > NET_HAR_MAX_BYTES) { truncated = true; break; }
      bytes += ex.resBytes; picked.unshift({ ...ex, resBody: ex.resBody() });
    }
    const har = netRules.buildHar(picked, { redact: { ...(net.redact || {}) }, version: net.version || '0' });
    res.writeHead(200, {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="brighttest-network.har"',
      ...(truncated ? { 'X-Brighttest-Truncated': '1' } : {}),
    });
    res.end(JSON.stringify(har));
    return true;
  }

  // /api/net/rules
  const ctl = createNetCtl({ proxy });
  if (req.method === 'GET') { sendJson(res, 200, { rules: proxy.ruleSet.list(), recording: !!proxy.recording }); return true; }
  if (req.method === 'DELETE') { const r = ctl.handle('reset', ''); sendJson(res, r.status, { ...r.json, rules: proxy.ruleSet.list() }); return true; }
  let text;
  try { text = await readRawBody(req, NET_RULE_BODY_MAX).then((b) => b.toString('utf8')); } catch (e) { sendJson(res, 413, { error: e.message, code: 'TOO_LARGE' }); return true; }
  let rule;
  try { rule = JSON.parse(text || '{}'); } catch { sendJson(res, 400, { error: 'body is not valid JSON' }); return true; }
  const isFault = rule && typeof rule === 'object' && (rule.kind !== undefined || rule.fault !== undefined);
  const r = ctl.handle(isFault ? 'fault' : 'mock', text);
  sendJson(res, r.status, { ...r.json, ...(r.status === 200 ? { rules: proxy.ruleSet.list() } : {}) });
  return true;
}

// ---- State inspector (STA-S-T8; design app-state-devtools.md 4.9) -----------------------------------------------
// Routes over the in-process hub (net.hub: push, stateOps, log), all behind the device lease like the net routes:
//   GET    /api/state[?id=<cmd id>][&raw=1]   last state.snapshot, recent commands (ack phase), snapshot names, hellos
//   POST   /api/state/cmd                     one edit { layer?, path, value, node?, ack? } (or { ops: [...] }); 202 {id, seq, session, step}
//   GET    /api/state/snapshots[?name=][&raw=1]   names, or one snapshot's layers (the export)
//   POST   /api/state/snapshots               { action: save|restore|import, name, layers? }
//   DELETE /api/state/snapshots?name=
//   GET    /api/state/diff?a=&b=[&raw=1]      layer-scoped diff of two stored snapshots
//   GET    /api/state/actions[?raw=1]         action log: state.action events (oldest first) with hashBefore/hashAfter and the recorded snapshot name
//   POST   /api/state/actions                 { action: record, entry? } snapshot the live state onto the newest entry
//                                             { action: travel, entry }  restore the snapshot recorded on that entry
//   GET    /api/state/fixtures                names of <root>/fixtures/state/*.json
//   POST   /api/state/fixtures                { action: save, name, snapshot?, raw? } write a stored snapshot; { action: load, name } read one back into the store
// Edits go through the flow step validator (state-steps), so Studio and flows accept the same paths, layers and sizes.
// Everything is redacted like the event stream; only ?raw=1 (the panel's "show raw" toggle) returns raw values.
const STATE_BODY_MAX = 256 * 1024;
const STATE_CMDS_SHOWN = 50;
const STATE_WAIT_MS = 12000;
const STATE_LAYERS = ['global', 'scene', 'node', 'registry']; // the layers restore and set accept

const STATE_ROUTES = { '/api/state': ['GET'], '/api/state/cmd': ['POST'], '/api/state/snapshots': ['GET', 'POST', 'DELETE'], '/api/state/diff': ['GET'], '/api/state/actions': ['GET', 'POST'], '/api/state/fixtures': ['GET', 'POST'] };
const STATE_ACTIONS_SHOWN = 200;
const STATE_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const stateNameOk = (n) => typeof n === 'string' && STATE_NAME_RE.test(n) && !/^\.+$/.test(n) && n !== '__proto__';

// Read a capped body: past the cap the rest is drained and discarded (never destroy the socket), so the caller can answer 413.
function readCapped(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0, over = false;
    req.on('data', (c) => { n += c.length; if (n > max) over = true; else chunks.push(c); });
    req.on('end', () => resolve({ over, buf: Buffer.concat(chunks) }));
    req.on('error', reject);
  });
}
// The agent already masks secret-looking keys with "<redacted:key>" before publishing, so a placeholder is never a real value.
const hasPlaceholder = (v) => /"<redacted:[^"]*>"/.test(JSON.stringify(v === undefined ? null : v));
const countPlaceholders = (v) => (JSON.stringify(v).match(/"<redacted:[^"]*>"/g) || []).length;
const stateSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quoteYaml = (v) => JSON.stringify(v);

async function handleState(p, req, res, url, net, gate, hubCtl = null, readLayers = null, extra = {}) {
  const known = STATE_ROUTES[p];
  if (!(p === '/api/state' || p.startsWith('/api/state/'))) return false;
  if (!known) { sendJson(res, 404, { error: `unknown route ${p}`, code: 'NOT_FOUND' }); return true; }
  if (!known.includes(req.method)) { res.writeHead(405, { Allow: known.join(', '), 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'method not allowed', code: 'METHOD' })); return true; }
  if ((!net || !net.hub) && hubCtl) {
    if (!(await gate(false))) return true;
    await hubCtl.ready();
    net = hubCtl.net();
  }
  if (!net || !net.hub || !net.hub.stateOps) { sendJson(res, 503, { error: (hubCtl && hubCtl.message()) || 'no instrument hub is running in Studio; start one with the net lane (see docs/e2e/network.md)', code: 'NO_HUB' }); return true; }
  if (!(await gate(req.method !== 'GET'))) return true;
  const hub = net.hub;
  const ops = hub.stateOps;
  const paths = net.redactPaths || [];
  const q = url.searchParams;
  const raw = q.get('raw') === '1';
  const shown = (v) => (raw ? v : redactData(v, paths));
  // A command's `result` can carry whole layers (snapshot, get): mask it with the configured paths, like the log does.
  const showCmd = (c) => (raw || !c || c.result === undefined ? c : { ...c, result: redactData(c.result, paths) });
  const showLayers = (L) => {
    const out = {};
    const masked = raw ? null : redactData({ layers: Object.fromEntries(Object.entries(L).map(([k, v]) => [k, v.state])) }, paths).layers;
    for (const [k, v] of Object.entries(L)) out[k] = raw ? v : { ...v, state: masked[k] };
    return out;
  };
  const fail = (status, code, message) => { sendJson(res, status, { error: message, code }); return true; };

  if (p === '/api/state') {
    const timed = ops.tick(Date.now());
    const id = q.get('id');
    if (id) {
      const c = ops.get(id);
      return c ? (sendJson(res, 200, { session: hub.sessionId, command: showCmd(c) }), true) : fail(404, 'NOT_FOUND', `no command ${id}`);
    }
    // The live tree is the app's __bt_agent node read over ECP (the agent only posts acks), the same source as /api/tree.
    let agent = null, readFail = null;
    if (readLayers) { try { agent = await readLayers(); } catch (e) { readFail = { message: e.message || String(e), code: e.code || null }; } }
    sendJson(res, 200, {
      session: hub.sessionId, hellos: hub.hellos || 0, lastHelloAt: hub.lastHelloAt == null ? null : hub.lastHelloAt, raw, timedOut: timed.length,
      layers: agent && agent.present && !agent.error ? showLayers(agent.layers || {}) : null,
      agentError: readFail ? readFail.message : agent && agent.error ? agent.error : null,
      agentReadFailed: !!readFail, agentCode: readFail ? readFail.code : null,
      commands: ops.list().slice(-STATE_CMDS_SHOWN).map(showCmd), gaps: ops.gaps, snapshots: ops.listSnapshots(),
    });
    return true;
  }

  // Action log: the app's state.action events (greenfield BTStore / config-named dispatch wrap), oldest first. An entry
  // knows the state hash before and after; a recorded entry also names the stored snapshot that time travel restores.
  const actionSnaps = extra.actionSnaps || (extra.actionSnaps = new Map()); // `${session}:${seq}` -> snapshot name
  const actionEntries = () => {
    const evs = hub.log && hub.log.since ? hub.log.since(0).filter((e) => e.kind === 'state.action') : [];
    return evs.slice(-STATE_ACTIONS_SHOWN).map((e) => {
      const d = e.data || {};
      // BrightScript AA literal keys lose their case on a device (`hashbefore`), so accept both spellings; always answer camelCase.
      const pick = (a, b) => (d[a] !== undefined ? d[a] : d[b] !== undefined ? d[b] : null);
      const hb = pick('hashBefore', 'hashbefore'), ha = pick('hashAfter', 'hashafter');
      const snap = actionSnaps.get(`${e.session || hub.sessionId}:${e.seq}`) || null;
      return { entry: e.seq, ts: e.ts, source: d.source || null, type: d.type === undefined ? null : d.type, payload: d.payload === undefined ? null : shown(d.payload),
        hashBefore: hb, hashAfter: ha, changed: hb !== null && ha !== null ? hb !== ha : null,
        snapshot: snap && ops.getSnapshot(snap) ? snap : null };
    });
  };

  if (p === '/api/state/actions' && req.method === 'GET') {
    sendJson(res, 200, { session: hub.sessionId, raw, actions: actionEntries() });
    return true;
  }

  const fixturesDir = path.join(extra.rootDir || process.cwd(), 'fixtures', 'state');
  if (p === '/api/state/fixtures' && req.method === 'GET') {
    let names = [];
    try { names = fs.readdirSync(fixturesDir).filter((f) => /\.json$/.test(f)).map((f) => f.slice(0, -5)).filter(stateNameOk).sort(); } catch { /* no fixtures yet */ }
    sendJson(res, 200, { fixtures: names });
    return true;
  }

  if (p === '/api/state/diff') {
    const a = q.get('a'), b = q.get('b');
    const la = a && ops.getSnapshot(a), lb = b && ops.getSnapshot(b);
    if (!la || !lb) return fail(404, 'NOT_FOUND', `snapshot not found: ${!la ? a : b}`);
    const wrap = (l) => ({ layers: shown(l) });
    sendJson(res, 200, { a, b, raw, diff: diffLayers(wrap(la).layers, wrap(lb).layers) });
    return true;
  }

  let body = {};
  if (req.method === 'POST') {
    const got = await readCapped(req, STATE_BODY_MAX);
    if (got.over) return fail(413, 'STATE_TOO_LARGE', `body exceeds ${STATE_BODY_MAX} bytes`);
    const text = got.buf.toString('utf8');
    try { body = JSON.parse(text || '{}'); } catch { return fail(400, 'BAD_COMMAND', 'body is not valid JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'BAD_COMMAND', 'body must be a JSON object');
  }

  // Queue a command; a wait=true caller gets the settled command back.
  const queue = (op, args, ack) => {
    const draft = ops.prepare({ op, args, ack });
    return hub.push({ op: draft.op, args: draft.args, ack: draft.ack }, { ack: draft.ack });
  };
  const settle = async (id) => {
    const deadline = Date.now() + STATE_WAIT_MS;
    for (;;) {
      ops.tick(Date.now());
      const c = ops.get(id);
      if (c && c.status === 'done') return c;
      if (c && c.status !== 'pending') throw Object.assign(new Error(`${c.error || c.status} (ack phase reached: ${c.phase || 'none'})`), { code: 'CMD_FAILED' });
      if (Date.now() >= deadline) throw Object.assign(new Error('no ack from the app in time'), { code: 'ACK_TIMEOUT' });
      await stateSleep(25);
    }
  };
  const typed = (e) => fail(e && (e.code === 'STATE_TOO_LARGE' || e.code === 'TOO_LARGE') ? 413 : e && e.code === 'STORE_FULL' ? 409 : 400, (e && e.code) || 'BAD_COMMAND', e.message);

  if (p === '/api/state/cmd') {
    let step;
    try {
      const arg = { ...body };
      if (arg.layer === undefined) arg.layer = 'global';
      step = stateSteps.normalizeStep('setState', arg, 0, class extends Error {});
    } catch (e) { return fail(400, 'BAD_COMMAND', String(e.message).replace(/^line 0: /, '')); }
    if (hasPlaceholder([step.value, step.ops])) return fail(400, 'REDACTED_VALUE', 'the value is a <redacted:...> placeholder (a masked field, not a real value); writing it would put that text into the app. Enter the real value');
    if (step.layer === 'registry' && step.path && step.path.split('.').length !== 2) return fail(400, 'BAD_COMMAND', 'registry edits are one <section>.<key> value at a time; a nested path would write the wrong key. Edit the whole value instead');
    if (!(hub.hellos > 0)) return fail(409, 'STATE_NOT_INSTRUMENTED', 'no agent.hello seen: the app build is not instrumented or has not connected to the hub yet');
    try {
      const cmd = stateSteps.setStateCommand(step);
      const full = queue(cmd.op, cmd.args, step.ack || 'applied');
      const { line, op, ...flow } = step; // eslint-disable-line no-unused-vars
      const text = `- setState: { ${Object.entries(flow).map(([k, v]) => `${k}: ${quoteYaml(v)}`).join(', ')} }`;
      sendJson(res, 202, { id: full.id, seq: full.seq, session: hub.sessionId, step: text });
    } catch (e) { return typed(e); }
    return true;
  }

  if (p === '/api/state/actions') {
    const list = actionEntries();
    const entry = body.entry === undefined ? null : Number(body.entry);
    if (body.action === 'record') {
      const newest = list[list.length - 1];
      if (!newest) return fail(404, 'NOT_FOUND', 'the action log is empty');
      if (entry !== null && entry !== newest.entry) return fail(409, 'STALE_ENTRY', `the live state is the state after the newest entry (${newest.entry}); older entries cannot be recorded now`);
      if (!(hub.hellos > 0)) return fail(409, 'STATE_NOT_INSTRUMENTED', 'no agent.hello seen: the app build is not instrumented or has not connected to the hub yet');
      const snapName = `act-${newest.entry}`;
      try {
        const c = await settle(queue('snapshot', { name: snapName }, 'applied').id);
        const layers = c.result && c.result.layers;
        if (!layers || typeof layers !== 'object') return fail(502, 'CMD_FAILED', 'the agent returned no layers');
        ops.saveSnapshot(snapName, layers, Date.now());
      } catch (e) {
        if (e && (e.code === 'CMD_FAILED' || e.code === 'ACK_TIMEOUT')) return fail(502, e.code, e.message);
        return typed(e);
      }
      actionSnaps.set(`${hub.sessionId}:${newest.entry}`, snapName);
      sendJson(res, 200, { ok: true, entry: newest.entry, snapshot: snapName, actions: actionEntries() });
      return true;
    }
    if (body.action === 'travel') {
      const found = entry !== null && list.find((a) => a.entry === entry);
      if (!found) return fail(404, 'NOT_FOUND', `no action log entry ${body.entry}`);
      if (!found.snapshot) return fail(409, 'NO_SNAPSHOT', `entry ${found.entry} has no recorded snapshot; record one while it is the newest entry`);
      if (!(hub.hellos > 0)) return fail(409, 'STATE_NOT_INSTRUMENTED', 'no agent.hello seen: the app build is not instrumented or has not connected to the hub yet');
      const layers = ops.getSnapshot(found.snapshot);
      const skipped = countPlaceholders(layers);
      const full = queue('restore', { name: found.snapshot, layers }, body.ack === 'reflected' ? 'reflected' : 'applied');
      sendJson(res, 202, { id: full.id, seq: full.seq, session: hub.sessionId, entry: found.entry, snapshot: found.snapshot, hashAfter: found.hashAfter,
        note: `restores the recorded state only; effects of later actions (network, registry, tasks) are not undone${skipped ? `; ${skipped} redacted value${skipped === 1 ? '' : 's'} will be skipped` : ''}` });
      return true;
    }
    return fail(400, 'BAD_COMMAND', 'action must be record or travel');
  }

  if (p === '/api/state/fixtures') {
    if (!stateNameOk(body.name)) return fail(400, 'BAD_COMMAND', 'name must be 1-64 letters, digits, "_", "-" or ".", and not "." / ".." / "__proto__"');
    const file = path.join(fixturesDir, `${body.name}.json`);
    if (body.action === 'save') {
      const layers = ops.getSnapshot(body.snapshot === undefined ? body.name : body.snapshot);
      if (!layers) return fail(404, 'NOT_FOUND', `snapshot not found: ${body.snapshot === undefined ? body.name : body.snapshot}`);
      const out = body.raw === true ? layers : redactData({ layers }, paths).layers; // redacted by default, like the export
      fs.mkdirSync(fixturesDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ v: 1, name: body.name, layers: out }, null, 2) + '\n');
      sendJson(res, 200, { ok: true, name: body.name, file: `fixtures/state/${body.name}.json`, redacted: body.raw !== true });
      return true;
    }
    if (body.action === 'load') {
      let doc;
      try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fail(404, 'NOT_FOUND', e && e.code === 'ENOENT' ? `fixture not found: ${body.name}` : `fixture ${body.name} is not valid JSON`); }
      const layers = doc && doc.layers;
      if (!layers || typeof layers !== 'object' || Array.isArray(layers)) return fail(400, 'BAD_COMMAND', `fixture ${body.name} has no layers object`);
      const bad = Object.keys(layers).filter((k) => !STATE_LAYERS.includes(k));
      if (bad.length) return fail(400, 'BAD_COMMAND', `fixture: unknown layer ${bad.map((k) => JSON.stringify(k)).join(', ')} (allowed: ${STATE_LAYERS.join(', ')})`);
      try { ops.saveSnapshot(body.name, layers, Date.now()); } catch (e) { return typed(e); }
      sendJson(res, 200, { ok: true, name: body.name, snapshots: ops.listSnapshots() });
      return true;
    }
    return fail(400, 'BAD_COMMAND', 'action must be save or load');
  }

  // /api/state/snapshots
  if (req.method === 'GET') {
    const name = q.get('name');
    if (!name) { sendJson(res, 200, { snapshots: ops.listSnapshots() }); return true; }
    const layers = ops.getSnapshot(name);
    if (!layers) return fail(404, 'NOT_FOUND', `snapshot not found: ${name}`);
    sendJson(res, 200, { name, raw, layers: shown(layers) });
    return true;
  }
  if (req.method === 'DELETE') {
    const name = q.get('name');
    if (!name || !ops.deleteSnapshot(name)) return fail(404, 'NOT_FOUND', `snapshot not found: ${name}`);
    sendJson(res, 200, { ok: true, snapshots: ops.listSnapshots() });
    return true;
  }
  const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
  const name = body.name;
  if (typeof name !== 'string' || !NAME_RE.test(name) || /^\.+$/.test(name) || name === '__proto__') return fail(400, 'BAD_COMMAND', 'name must be 1-64 letters, digits, "_", "-" or ".", and not "." / ".." / "__proto__"');
  try {
    if (body.action === 'import') {
      if (!body.layers || typeof body.layers !== 'object' || Array.isArray(body.layers)) return fail(400, 'BAD_COMMAND', 'import needs layers: { <layer>: ... }');
      const bad = Object.keys(body.layers).filter((k) => !STATE_LAYERS.includes(k));
      if (bad.length) return fail(400, 'BAD_COMMAND', `import: unknown layer ${bad.map((k) => JSON.stringify(k)).join(', ')} (allowed: ${STATE_LAYERS.join(', ')})`);
      ops.saveSnapshot(name, body.layers, Date.now());
      sendJson(res, 200, { ok: true, name, snapshots: ops.listSnapshots() });
      return true;
    }
    if (!(hub.hellos > 0)) return fail(409, 'STATE_NOT_INSTRUMENTED', 'no agent.hello seen: the app build is not instrumented or has not connected to the hub yet');
    if (body.action === 'save') {
      const c = await settle(queue('snapshot', { name }, 'applied').id);
      const layers = c.result && c.result.layers;
      if (!layers || typeof layers !== 'object') return fail(502, 'CMD_FAILED', 'the agent returned no layers');
      ops.saveSnapshot(name, layers, Date.now());
      sendJson(res, 200, { ok: true, name, snapshots: ops.listSnapshots() });
      return true;
    }
    if (body.action === 'restore') {
      const layers = ops.getSnapshot(name);
      if (!layers) return fail(404, 'NOT_FOUND', `snapshot not found: ${name}`);
      const skipped = countPlaceholders(layers);
      const full = queue('restore', { name, layers }, body.ack === 'reflected' ? 'reflected' : 'applied');
      sendJson(res, 202, { id: full.id, seq: full.seq, session: hub.sessionId, step: `- restore: ${quoteYaml(name)}`,
        ...(skipped ? { note: `${skipped} redacted value${skipped === 1 ? '' : 's'} (<redacted:...> markers) will be skipped on restore` } : {}) });
      return true;
    }
    return fail(400, 'BAD_COMMAND', 'action must be save, restore or import');
  } catch (e) {
    if (e && (e.code === 'CMD_FAILED' || e.code === 'ACK_TIMEOUT')) return fail(502, e.code, e.message);
    return typed(e);
  }
}

function serveStatic(res, urlPath) {
  const file = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
  const full = path.join(PUBLIC, path.normalize(file));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

// Run traces for the time-travel viewer, PERSISTED to disk under <rootDir>/.brighttest/studio/runs so
// they survive restarts: each run is a dir <id>/ with meta.json (steps + tree) and <step>.jpg frames.
// In memory we keep only the metadata list (loaded on startup); frames are read from disk on demand.
let traceSeq = 0;
const MAX_RUNS = 20;
const runs = []; // oldest → newest (metadata)
const findRun = (id) => runs.find((r) => r.id === id);
const runFramePath = (dir, id, step) => path.join(dir, String(id), `${step}.jpg`);
const writeMeta = (dir, run) => { try { fs.writeFileSync(path.join(dir, String(run.id), 'meta.json'), JSON.stringify({ id: run.id, flow: run.flow, startedAt: run.startedAt, ok: run.ok, steps: run.steps })); } catch {} };

function loadRuns(dir) {
  runs.length = 0; traceSeq = 0;
  let ids;
  try { ids = fs.readdirSync(dir).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b); } catch { return; }
  for (const id of ids) {
    try { runs.push(JSON.parse(fs.readFileSync(path.join(dir, String(id), 'meta.json'), 'utf8'))); traceSeq = Math.max(traceSeq, id); }
    catch { /* skip corrupt */ }
  }
}
function pruneRuns(dir) {
  while (runs.length > MAX_RUNS) {
    const old = runs.shift();
    try { fs.rmSync(path.join(dir, String(old.id)), { recursive: true, force: true }); } catch {}
  }
}

// Run a flow on the device, streaming per-step results over SSE. Reuses the e2e runner's execStep so studio
// playback matches `brighttest e2e run`. After each step it writes a frame (screenshot) to disk + captures
// the node tree so the run can be scrubbed later (persisted). Stops at the first failure.
async function runFlowSSE(res, full, rel, device, app, runsDir, screen, signal) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  let flow;
  try { flow = flowLib.loadFlow(full); }
  catch (e) { send({ type: 'error', error: e.message }); return res.end(); }

  // The step context carries the abort signal and a guarded device: once the lease is lost or released,
  // every device call (inside a count press, a poll, a sub-flow) throws instead of reaching the device.
  const ctx = {
    device: guardDevice(device, signal), signal,
    stepTimeoutMs: (flow.config && flow.config.timeout ? flow.config.timeout : 10) * 1000,
    opts: { app }, flow, launchParams: {},
    noSystemDialog: !!(flow.config && flow.config.noSystemDialog === true),
    deviceInfo: null,
  };
  try { ctx.deviceInfo = await device.deviceInfo(); } catch { /* unknown values make requires: unmet, with that reason */ }
  if (flow.requires) { // flow-level requires: skip before the first step; no device call beyond the info read above
    const why = flowLib.checkRequires(flow.requires, ctx.deviceInfo);
    if (why) { send({ type: 'skipped', reason: why }); send({ type: 'done', ok: true, skipped: why }); return res.end(); }
  }
  const runId = ++traceSeq;
  const run = { id: runId, flow: rel || path.basename(full), startedAt: Date.now(), ok: null, steps: [] };
  runs.push(run);
  try { fs.mkdirSync(path.join(runsDir, String(runId)), { recursive: true }); } catch {}

  send({ type: 'start', runId, flow: run.flow, steps: flow.steps.map((s, i) => ({ index: i, op: s.op, line: s.line })) });

  // The device lease was lost or released: stop at once, touch the device no more, end the stream.
  const abortRun = () => {
    const reason = String((signal && signal.reason) || 'device lease lost');
    run.ok = false; writeMeta(runsDir, run); pruneRuns(runsDir);
    send({ type: 'aborted', reason, runId });
    send({ type: 'done', ok: false, aborted: true, runId });
    return res.end();
  };
  const aborted = signal ? new Promise((r) => { if (signal.aborted) r('aborted'); else signal.addEventListener('abort', () => r('aborted'), { once: true }); }) : null;

  for (let i = 0; i < flow.steps.length; i++) {
    if (signal && signal.aborted) return abortRun();
    const step = flow.steps[i];
    send({ type: 'step', index: i, op: step.op, status: 'running', selector: step.selector || null });

    let status = 'pass', detail = '', error = null;
    try {
      const exec = Promise.resolve(execStep(step, ctx));
      if (aborted) exec.catch(() => {}); // an abandoned step's late failure is not reported
      const r = aborted ? await Promise.race([exec, aborted]) : await exec;
      if (r === 'aborted' && signal.aborted) return abortRun();
      detail = (r && r.detail) || '';
    }
    catch (e) {
      if (e && e.code === 'REQUIRES_UNMET') { // a skip, not a failed step
        run.ok = true; writeMeta(runsDir, run); pruneRuns(runsDir);
        send({ type: 'step', index: i, op: step.op, status: 'skipped', detail: e.message, runId });
        send({ type: 'done', ok: true, skipped: e.message, runId });
        return res.end();
      }
      status = 'fail'; error = e.message;
    }
    if (signal && signal.aborted) return abortRun();

    // Capture the resulting state for the trace (best-effort — a capture failure never fails the run).
    let scene = null, nodes = null, appState = null, frame = false;
    try {
      const tree = await sg.fetchTree(device, { retries: 2, backoffMs: 150 });
      ({ scene, nodes } = coords.project(tree.roots, { screen, layout: appstate.extractLayoutHints(tree.roots) }));
      appState = appstate.extractAppState(tree.roots);
    } catch {}
    // The dev screenshot endpoint 404s momentarily during transitions — retry once so fewer steps are frameless.
    for (let a = 0; a < 2 && !frame; a++) {
      try { const shot = await device.screenshot(); fs.writeFileSync(runFramePath(runsDir, runId, i), shot.buffer); frame = true; }
      catch { await new Promise((r) => setTimeout(r, 300)); }
    }

    const rec = { index: i, op: step.op, status, detail: error || detail, selector: step.selector || null, scene, nodes, appState, frame };
    run.steps.push(rec);
    send({ type: 'step', ...rec, error, runId });
    if (status === 'fail') { run.ok = false; writeMeta(runsDir, run); pruneRuns(runsDir); send({ type: 'done', ok: false, runId }); return res.end(); }
  }
  run.ok = true;
  writeMeta(runsDir, run); pruneRuns(runsDir);
  send({ type: 'done', ok: true, runId });
  res.end();
}

// Loopback-only request guard (DNS rebinding, cross-site form posts, no-cors fetches).
// Returns null if the request may proceed, else { code, error }.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const hostnameOf = (hostHeader) => {
  const m = /^(\[[^\]]*\]|[^:]*)(?::\d+)?$/.exec(String(hostHeader || '').trim().toLowerCase());
  return m ? m[1].replace(/\.$/, '') : null; // drop port and one trailing dot
};
function guardRequest(req, port) {
  const host = hostnameOf(req.headers.host);
  if (!host || !LOOPBACK_HOSTS.has(host)) return { code: 403, error: 'forbidden host' };
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return { code: 403, error: 'cross-site request refused' };
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let ok = false;
    try { const o = new URL(origin); ok = o.protocol === 'http:' && LOOPBACK_HOSTS.has(o.hostname.replace(/\.$/, '')) && Number(o.port || 80) === port; } catch { /* "null" etc. */ }
    if (!ok) return { code: 403, error: 'forbidden origin' };
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const raw = req.url.split('?')[0] === '/api/perf/bsprof' && ct === 'application/octet-stream'; // .bsprof import
    if (ct !== 'application/json' && !raw) return { code: 415, error: 'content-type must be application/json' };
  }
  return null;
}

// Start the studio server. Returns the http.Server (for tests/shutdown). `rootDir`/`flowsDir` scope the
// real project flow files the studio reads and writes (defaults: cwd and cwd/flows).
// Resolve Studio's device with the same rules as the CLI lanes (lib/device-command.js): an explicit host is
// kept as given; with none, ROKU_HOST/ROKU_PASSWORD or exactly one cached device is used, several cached
// devices fail (no guess), and a host with no known password fails like the lanes do. Nothing known: device-less.
// A pool member's password, by the same rule as the pool preflight (flag, ROKU_PASSWORD, .env, device cache).
function memberPassword(host, opts = {}) { return devices.resolveDevice({ host, password: opts.password }).password; }

function resolveStudioTarget({ host, password } = {}) {
  if (host) return { host, password };
  const dc = require('../device-command');
  const ambiguous = dc.ambiguousHostMessage({});
  if (ambiguous) throw new Error(ambiguous);
  const t = dc.resolveTarget({ password });
  if (!t.host) return { host: null, password: null };
  if (!t.password) throw new Error(`no password for device ${t.host}: pass --password or set ROKU_PASSWORD`);
  return { host: t.host, password: t.password };
}

// Studio's instrument hub (STUDIO-HUB-WIRE). Started while Studio holds the device lease, stopped when the lease is
// released or lost and when the server stops. Host and port come from instrument.hub.* (hubAddress), the token from
// BRIGHTTEST_HUB_TOKEN (32 lowercase hex); the token is never logged or returned. The Studio-side proxy emits into
// the hub log so the Network panel sees its traffic. `seam` = { startLanHub, env, log } (tests).
// instrument.state.redact.paths from brighttest.json: the masks the agent and the hub log apply to state values.
function statePaths(cfg) {
  const r = cfg && cfg.instrument && cfg.instrument.state && cfg.instrument.state.redact;
  return r && Array.isArray(r.paths) ? r.paths.filter((v) => typeof v === 'string') : [];
}

function studioHub({ host, cfg, seam = {}, log = () => {} }) {
  const env = seam.env || process.env;
  const start = seam.startLanHub || startLanHub;
  let cur = null;       // { hub, proxy, net }
  let pending = null;
  let gen = 0;
  let message = null;
  const noToken = `no instrument hub: Studio could not start one because ${HUB_TOKEN_ENV} is missing or not 32 lowercase hex characters; set it (the same value the app was built with via instrument build --net) and restart Studio`;
  const shutdown = async () => {
    const c = cur; cur = null;
    if (!c) return;
    try { c.proxy.close(); } catch { /* best-effort */ }
    try { await c.hub.stop(); } catch { /* best-effort */ }
  };
  const begin = async (lease, my) => {
    const token = hubTokenFromEnv(env);
    if (!token) { message = noToken; return; } // shown in the Network panel; Studio users without a hub get no log noise
    let addr;
    try { addr = hubAddress(cfg); } catch (e) { message = `no instrument hub: ${e.message}`; log(`[brighttest hub] ${message}`); return; }
    let hub = null;
    const proxy = createNetProxy({
      root: (cfg && cfg.rootDir) || process.cwd(), redact: (cfg && cfg.net && cfg.net.redact) || {},
      emit: (kind, data) => { if (hub && hub.emitLocal) { try { hub.emitLocal(kind, { ...data, lane: 'studio' }); } catch { /* best-effort */ } } },
    });
    try {
      hub = await start({ deviceHost: host, lease, tokens: [token], port: addr.port, netProxy: proxy, redactPaths: statePaths(cfg), env, log });
    } catch (e) {
      proxy.close();
      const inUse = e && e.code === 'EADDRINUSE';
      message = `no instrument hub: ${inUse ? `port ${addr.port} is already in use; free it or set instrument.hub.port in brighttest.json` : String(e.message || e).split(token).join('<token>')}`;
      log(`[brighttest hub] ${message}`);
      return;
    }
    if (my !== gen) { proxy.close(); try { await hub.stop(); } catch { /* best-effort */ } return; }
    message = null;
    cur = { hub, proxy, net: { proxy, hub, redactPaths: statePaths(cfg), events: hub.events, log: hub.log, hello: () => ({ hellos: hub.hellos || 0, lastHelloAt: hub.lastHelloAt == null ? null : hub.lastHelloAt }), redact: (cfg && cfg.net && cfg.net.redact) || {} } };
    log(`[brighttest hub] studio started the instrument hub on port ${hub.port}`);
  };
  return {
    // The lease was just acquired: (re)start the hub.
    started(lease) {
      const my = ++gen;
      const prev = pending;
      pending = (async () => { try { await prev; } catch { /* ignore */ } await shutdown(); await begin(lease, my); })().catch(() => {});
    },
    stop() { gen++; const prev = pending; pending = (async () => { try { await prev; } catch { /* ignore */ } await shutdown(); })(); return pending; },
    ready() { return pending || Promise.resolve(); },
    net() { return cur ? cur.net : null; },
    message() { return message || 'no instrument hub is running in Studio: it starts while Studio holds the device lease'; },
  };
}

// The built UI bundle is generated (npm run studio:build). With requireUi the server refuses to start without it
// instead of binding a port that can only answer 404. Never builds anything itself.
function uiBuildError(dir) {
  const e = new Error(`studio UI bundle not found at ${path.join(dir, 'index.html')}. Run: npm run studio:build`);
  e.code = 'UI_NOT_BUILT';
  return e;
}

function start(opts = {}) {
  if (opts.requireUi && !fs.existsSync(path.join(opts.publicDir || PUBLIC, 'index.html'))) return Promise.reject(uiBuildError(opts.publicDir || PUBLIC));
  const { port = 8700, app = null, rootDir = process.cwd(), flowsDir = null, cfg = null, leaseOpts = {}, portFallback = null, perfettoOpts = {}, perfettoSummaryOpts = {}, net = null } = opts;
  const netStreams = new Set();
  // deviceLease.pool with no --host: Studio binds one free pool member when it takes the lease (see ./lease.js).
  const dcmd = require('../device-command');
  const pool = dcmd.poolOf(cfg, { devicePool: true, host: opts.host });
  if (pool && pool.length) { const bad = dcmd.poolPreflight(pool, opts); if (bad) throw new Error(bad.replace('--device any: ', '')); }
  const { host, password } = pool && pool.length ? { host: null, password: null } : resolveStudioTarget(opts);
  // The active device can be (re)connected at runtime from the Devices page, so it's mutable.
  let device = host ? createDevice({ host, password }) : null;
  const current = { host: host || null };
  if (host) devices.rememberDevice(host, password);
  const flowsRoot = path.resolve(rootDir, flowsDir || 'flows');
  const runsDir = path.join(rootDir, '.brighttest', 'studio', 'runs');
  try { fs.mkdirSync(runsDir, { recursive: true }); } catch {}
  loadRuns(runsDir); // restore persisted run history across restarts
  // Device lease: Studio holds it only while in use; see ./lease.js.
  const sl = new StudioLease({
    host, cfg, acquireOpts: leaseOpts.acquireOpts, now: leaseOpts.now, log: leaseOpts.log, pool,
    // A pool member was chosen: that is the device Studio talks to until it releases and picks again.
    onBind: (h) => { device = createDevice({ host: h, password: memberPassword(h, opts) }); current.host = h; screen = null; },
  });
  const needDevice = () => { if (!device) throw Object.assign(new Error('no device connected'), { code: 'NO_DEVICE' }); return device; };
  // Independent coalesced lanes: the fast tree read never queues behind the slow screenshot. Fewer sgnodes
  // retries than the e2e default so a stale read fails fast and the next poll (≈300ms later) tries again.
  const getTree = coalesce(() => sg.fetchTree(needDevice(), { retries: 3, backoffMs: 150, serveCached: true }));
  // The inspector's own read: never a cached large tree, so an ack chip cannot be confirmed from a stale tree.
  const getAgentTree = coalesce(() => sg.fetchTree(needDevice(), { retries: 2, backoffMs: 150 }));
  let lastTree = null; // last good tree { tree, host, at } for stale answers when the render thread is busy
  const getShot = coalesce(() => needDevice().screenshot());

  // The UI coordinate space the overlay draws into, from the device's ui-resolution. Cached per device
  // (it can't change without a reconnect) and refreshed on /api/connect. Null until the first successful
  // read, in which case coords falls back to finding a full-screen node in the tree.
  let screen = null;
  // The active (or last) profiling session; kept after stop so it can still be exported.
  let perfSession = null;
  // Perfetto capture state (traces land under .brighttest/studio/profiling).
  const perfettoDir = path.join(rootDir, '.brighttest', 'studio', 'profiling');
  let perfetto = null;
  // The capture is keyed by the selected device's ESN (its serial) so the enable survives a Studio restart,
  // and it re-enables and reopens the stream after a dropped connection (bounded, see perfetto.js).
  // perfettoOpts is a test seam (stateDir, restart timings).
  const getPerfetto = async () => {
    if (!perfetto || perfetto.host !== current.host) {
      let esn = null;
      try { esn = (await needDevice().deviceCapabilities()).serial || null; } catch { /* unreachable: no persistence */ }
      if (perfetto && perfetto.host === current.host) return perfetto; // a concurrent call built it first
      perfetto = new PerfettoCapture({ host: current.host, channelId: app || 'dev', dir: perfettoDir, esn, autoRestart: true, ...perfettoOpts });
    }
    return perfetto;
  };
  // A running profiling session neither counts as activity nor holds the lease: when Studio yields (idle,
  // queued waiter, lost lease, released from the UI) the session is stopped cleanly and says why.
  sl.onRelease = (why) => {
    if (perfSession && perfSession.running) {
      perfSession.stop(`profiling stopped: Studio released the device (${why})`);
      sl.log(`[brighttest lease] studio stopped the profiling session (${why})`);
      sl.note(`profiling stopped: Studio released the device (${why})`);
    }
    // A Perfetto capture holds a WebSocket to the device: close it too (the stream goes quiet, the file is kept).
    if (perfetto && perfetto.tracing) {
      perfetto.stop().catch(() => {});
      sl.log(`[brighttest lease] studio stopped the Perfetto capture (${why})`);
      sl.note(`perfetto capture stopped: Studio released the device (${why})`);
    }
  };
  // Studio's own instrument hub lives inside the lease window (not with an explicitly passed opts.net).
  // Pool mode: the hub is bound to one host at start, so none runs; the routes explain why instead of "no hub".
  const poolHubCtl = { started() {}, stop() {}, ready() { return Promise.resolve(); }, net() { return null; }, message() { return 'The instrument hub is not started when Studio uses a device pool (deviceLease.pool). Start Studio with --host <ip> to use the Network and State panels.'; } };
  const hubCtl = net ? null : sl.pool ? poolHubCtl : !host ? null : studioHub({ host, cfg, seam: opts.hubOpts || {}, log: (s) => sl.log(s) });
  if (hubCtl) {
    const gotLease = sl.gotLease.bind(sl);
    sl.gotLease = (l, how) => { gotLease(l, how); hubCtl.started(l); };
    const prevRelease = sl.onRelease;
    sl.onRelease = (why) => { hubCtl.stop(); prevRelease(why); };
  }
  const leaseTimer = setInterval(() => sl.tick(), leaseOpts.tickMs || 1000);
  if (leaseTimer.unref) leaseTimer.unref();
  const learnScreen = (info) => { screen = coords.screenFromUiResolution(info && info.uiResolution) || screen; };
  const ensureScreen = async () => {
    if (screen || !device) return screen;
    try { learnScreen(await device.deviceInfo()); } catch { /* fall back to the tree heuristic */ }
    return screen;
  };

  // Resolve a client-supplied flow path against flowsRoot; refuse anything escaping it (path traversal).
  const safeFlow = (rel, requireYaml) => {
    const full = path.resolve(flowsRoot, rel || '');
    if (full !== flowsRoot && !full.startsWith(flowsRoot + path.sep)) { const e = new Error('path outside flows dir'); e.code = 'EPATH'; throw e; }
    if (requireYaml && !/\.e2e\.ya?ml$/i.test(full)) { const e = new Error('only *.e2e.yaml files can be saved'); e.code = 'EPATH'; throw e; }
    return full;
  };

  const summaryPool = createSummaryPool();
  const stateExtra = { rootDir, actionSnaps: new Map() };
  const server = http.createServer(async (req, res) => {
    const denied = guardRequest(req, server.address().port);
    if (denied) return sendJson(res, denied.code, { error: denied.error });
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    // Take (or confirm) the device lease before touching the device; 423 + status JSON when someone else has it.
    const gate = async (user) => {
      if (await sl.ensure({ user })) return true;
      const info = await sl.info();
      sendJson(res, 423, { error: StudioLease.describe(info), code: 'LOCKED', lease: info });
      return false;
    };
    try {
      if (await handleNet(p, req, res, url, net, gate, netStreams, hubCtl)) return;
      if (await handleState(p, req, res, url, net, gate, hubCtl, async () => agentLayers((await getAgentTree()).roots), stateExtra)) return;
      if (p === '/api/lease') {
        if (req.method === 'POST') {
          const { action } = await readBody(req);
          if (action === 'acquire') { if (!(await sl.ensure({ user: true }))) sl.takeOver(); }
          else if (action === 'release') { sl.release('released from the UI'); sl.yielded = true; }
          else return sendJson(res, 400, { error: 'action must be "acquire" or "release"' });
        }
        return sendJson(res, 200, await sl.info());
      }
      if (p === '/api/device') {
        if (!device) return sendJson(res, 200, { connected: false });
        try {
          const info = await device.deviceInfo();
          learnScreen(info);
          return sendJson(res, 200, { connected: true, host: current.host, ...info });
        }
        catch (e) { return sendJson(res, 200, { connected: false, host: current.host, error: e.message }); }
      }
      if (p === '/api/discover') {
        return sendJson(res, 200, await devices.discover({ timeoutMs: 3500 }));
      }
      if (p === '/api/cached') {
        return sendJson(res, 200, devices.cachedDevices());
      }
      if (p === '/api/connect' && req.method === 'POST') {
        const { host: h, password: pw } = await readBody(req);
        if (!h) return sendJson(res, 400, { error: 'host required' });
        const secret = pw || devices.cachedPassword(h);
        const cand = createDevice({ host: h, password: secret });
        try {
          const info = await cand.deviceInfo();
          device = cand; current.host = h;
          screen = null; learnScreen(info);
          devices.rememberDevice(h, secret, info.model);
          sl.setHost(h);
          if (app && await sl.ensure({ user: true })) device.launch(app, {}).catch(() => {});
          return sendJson(res, 200, { connected: true, host: h, ...info });
        } catch (e) { return sendJson(res, 400, { error: `could not reach ${h}: ${e.message}` }); }
      }
      if (p === '/api/flows') {
        let files = [];
        try { files = flowLib.collectFlowFiles([flowsRoot]); } catch { /* dir may not exist yet */ }
        return sendJson(res, 200, { dir: flowsRoot, files: files.map((f) => ({ name: path.basename(f), rel: path.relative(flowsRoot, f) })) });
      }
      if (p === '/api/flow' && req.method === 'GET') {
        const rel = url.searchParams.get('file');
        const text = fs.readFileSync(safeFlow(rel), 'utf8');
        return sendJson(res, 200, { rel, text });
      }
      if (p === '/api/flow' && req.method === 'POST') {
        const { file: rel, text } = await readBody(req);
        const full = safeFlow(rel, true);
        try { flowLib.parseFlow(String(text)); } catch (e) { return sendJson(res, 400, { error: e.message }); }
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, String(text));
        return sendJson(res, 200, { ok: true, rel: path.relative(flowsRoot, full) });
      }
      if (p === '/api/run') {
        if (!device) return sendJson(res, 400, { error: 'no device connected' });
        if (!(await gate(true))) return;
        const rel = url.searchParams.get('file');
        const scr = await ensureScreen();
        return sl.during((signal) => runFlowSSE(res, safeFlow(rel), rel, device, app, runsDir, scr, signal));
      }
      if (p === '/api/runs') {
        return sendJson(res, 200, runs.slice().reverse().map((r) => ({
          id: r.id, flow: r.flow, startedAt: r.startedAt, ok: r.ok, total: r.steps.length,
          passed: r.steps.filter((s) => s.status === 'pass').length,
          failed: r.steps.filter((s) => s.status === 'fail').length,
        })));
      }
      if (p.startsWith('/api/runs/')) {
        const r = findRun(Number(p.slice('/api/runs/'.length)));
        if (!r) { res.writeHead(404); return res.end('no run'); }
        return sendJson(res, 200, { id: r.id, flow: r.flow, startedAt: r.startedAt, ok: r.ok, steps: r.steps });
      }
      if (p === '/api/trace/frame') {
        const step = Number(url.searchParams.get('step'));
        const rid = Number(url.searchParams.get('run')) || (runs.length ? runs[runs.length - 1].id : 0);
        try {
          const buf = fs.readFileSync(runFramePath(runsDir, rid, step));
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
          return res.end(buf);
        } catch { res.writeHead(404); return res.end('no frame'); }
      }
      if (p === '/api/tree') {
        if (!(await gate(false))) return;
        const build = async (tree) => ({
          ...coords.project(tree.roots, { screen: await ensureScreen(), layout: appstate.extractLayoutHints(tree.roots) }),
          appState: appstate.extractAppState(tree.roots),
          agent: agentLayers(tree.roots),
        });
        let tree;
        try {
          tree = await getTree();
        } catch (e) {
          if (process.env.BRIGHTTEST_DEBUG) console.error(`[studio] /api/tree read failed: code=${e.code || e.cause?.code || e.name || 'none'} ${e.message}`);
          if (!isTransientTreeError(e)) throw e;
          if (lastTree && lastTree.host === current.host) {
            // Fresh trees carry no `stale` key; only a served-from-cache tree has stale:true + staleSince.
            return sendJson(res, 200, { ...(await build(lastTree.tree)), stale: true, staleSince: lastTree.at });
          }
          res.setHeader('Retry-After', '1');
          return sendJson(res, 503, { error: e.message, code: e.code || null, retryable: true });
        }
        lastTree = { tree, host: current.host, at: new Date().toISOString() };
        return sendJson(res, 200, await build(tree));
      }
      if (p === '/api/screenshot') {
        if (!(await gate(false))) return;
        const shot = await getShot();
        res.writeHead(200, { 'Content-Type': shot.ext === 'png' ? 'image/png' : 'image/jpeg', 'Cache-Control': 'no-store' });
        return res.end(shot.buffer);
      }
      if (p === '/api/keypress' && req.method === 'POST') {
        if (!(await gate(true))) return;
        const { key, count } = await readBody(req);
        // A remote press during a live profiling session becomes a chart marker, so CPU/memory spikes
        // line up with what the operator did.
        if (perfSession && perfSession.running) perfSession.mark(`key: ${key}`);
        await device.keypressSeq(String(key), Number(count) || 1);
        return sendJson(res, 200, { ok: true });
      }

      // ---- Profiling ------------------------------------------------------------------------------
      if (p === '/api/perf/start' && req.method === 'POST') {
        if (!(await gate(true))) return;
        const { intervalMs } = await readBody(req);
        if (perfSession) perfSession.stop();
        perfSession = new perf.PerfSession(needDevice(), { intervalMs }).start();
        return sendJson(res, 200, { ok: true, startedAt: perfSession.startedAt, intervalMs: perfSession.intervalMs });
      }
      if (p === '/api/perf/stop' && req.method === 'POST') {
        if (perfSession) perfSession.stop();
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/perf/marker' && req.method === 'POST') {
        const { label } = await readBody(req);
        if (!perfSession) return sendJson(res, 400, { error: 'no session' });
        perfSession.mark(label);
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/perf/session') {
        if (!perfSession) return sendJson(res, 200, { exists: false });
        // `since` lets the client poll incrementally instead of re-downloading the whole session.
        const since = Number(url.searchParams.get('since')) || 0;
        return sendJson(res, 200, {
          exists: true, running: perfSession.running, stopReason: perfSession.stopReason || null, startedAt: perfSession.startedAt,
          intervalMs: perfSession.intervalMs, effectiveIntervalMs: perfSession.effectiveIntervalMs, error: perfSession.lastError,
          total: perfSession.samples.length,
          samples: perfSession.samples.slice(since),
          markers: perfSession.markers,
        });
      }
      if (p === '/api/perf/export') {
        if (!perfSession) return sendJson(res, 400, { error: 'no session to export' });
        const fmt = url.searchParams.get('format') === 'csv' ? 'csv' : 'json';
        const stamp = new Date(perfSession.startedAt).toISOString().replace(/[:.]/g, '-');
        res.writeHead(200, {
          'Content-Type': fmt === 'csv' ? 'text/csv' : 'application/json',
          'Content-Disposition': `attachment; filename="perf-${stamp}.${fmt}"`,
          'Cache-Control': 'no-store',
        });
        return res.end(fmt === 'csv' ? perfSession.toCSV() : JSON.stringify(perfSession.toJSON(), null, 2));
      }
      if (p === '/api/perf/textures') {
        if (!(await gate(true))) return;
        // One-shot texture inventory (separate from sessions — the full bitmap list is too heavy per-sample).
        const { text } = await needDevice().ecpGet('/query/r2d2-bitmaps');
        const r = perf.parseR2d2(text);
        if (!r.ok) return sendJson(res, 502, { error: r.error });
        return sendJson(res, 200, { ...r, bitmaps: r.bitmaps.slice(0, 100) });
      }
      if (p === '/api/perf/console' && req.method === 'POST') {
        // SceneGraph debug console (telnet :8080), whitelisted commands only.
        const { command } = await readBody(req);
        if (!sgdebug.COMMANDS[command]) return sendJson(res, 400, { error: `unknown command (allowed: ${Object.keys(sgdebug.COMMANDS).join(', ')})` });
        if (!current.host) return sendJson(res, 400, { error: 'no device connected' });
        if (!(await gate(true))) return;
        // Targeted commands (sgperf, loaded_textures, chanperf, ...) need the console `target` set to the
        // channel in front; the title comes from the active-app ECP query.
        let channel = null;
        if (sgdebug.TARGETED.has(command)) {
          let app;
          try { app = await needDevice().activeApp(); }
          catch (e) { return sendJson(res, 502, { error: `cannot read active app to pick the console target: ${e.message}` }); }
          if (app.home || !app.name) return sendJson(res, 409, { error: 'no channel in front (Home or unknown app): launch the channel before running this console command' });
          channel = app.name;
        }
        try { return sendJson(res, 200, await sgdebug.query(current.host, command, { channel })); }
        catch (e) {
          const notFound = /console target not found/.test(e.message);
          return sendJson(res, notFound ? 409 : 502, { error: e.message, ...(e.status ? { status: e.status, reason: e.reason } : {}), ...(notFound ? { code: 'TARGET_NOT_FOUND', channel } : {}) });
        }
      }
      if (p === '/api/perf/perfetto-summary' && req.method === 'GET') {
        // PRF-06: read-only, local, no device. Summarizes a saved trace in a worker thread (timeout + 32 MiB inflated bound).
        const name = String(url.searchParams.get('file') || '');
        const base = path.resolve(perfettoDir);
        let full = path.resolve(base, name);
        const badFile = () => sendJson(res, 400, { ok: false, error: { code: 'E_BAD_FILE', message: 'bad trace file name', offset: null } });
        if (!name || name.includes('\0') || path.basename(name) !== name || !full.startsWith(base + path.sep) || !full.endsWith('.perfetto-trace')) return badFile();
        try {
          // Resolve symlinks on both sides so a link inside the profiling dir cannot point outside it.
          const realBase = fs.realpathSync(base);
          const realFull = fs.realpathSync(full);
          if (!realFull.startsWith(realBase + path.sep)) return badFile();
          full = realFull;
        } catch { /* missing file or dir: the summarizer reports E_TRACE_READ (404) */ }
        const ac = new AbortController();
        res.on('close', () => { if (!res.writableFinished) ac.abort(); });
        const r = await summarizeIsolated(full, { ...perfettoSummaryOpts, pool: summaryPool, signal: ac.signal });
        if (ac.signal.aborted) return;
        const status = r.ok ? 200 : r.error.code === 'E_TRACE_BUSY' ? 503 : r.error.code === 'E_TRACE_READ' ? 404 : r.error.code === 'E_TRACE_TIMEOUT' ? 504 : r.error.code === 'E_TRACE_WORKER' ? 500 : r.error.code === 'E_TRACE_TOO_LARGE' ? 413 : 422;
        return sendJson(res, status, r);
      }
      if (p.startsWith('/api/perf/perfetto/')) {
        if (!current.host) return sendJson(res, 400, { error: 'no device connected' });
        const pf = await getPerfetto();
        const action = p.slice('/api/perf/perfetto/'.length);
        if (req.method === 'POST' && !(await gate(true))) return;
        try {
          if (action === 'status') {
            const info = { ...pf.status() };
            // What brighttest recorded (never the device state, which cannot be queried); no ESN in the payload.
            info.brighttestRecord = perfettoState.describeState(perfettoState.readState(pf.esn, { dir: pf.stateDir, staleMs: Infinity }));
            // staleMs: Infinity on purpose: display shows any record; the 6 h window only drives perfetto.js's re-enable.
            // Studio reports supported only on firmware 15.2 or later (the gate roku-debug applies, not a Roku-published minimum); perfetto.js asserts no minimum.
            try {
              const fw = String((await needDevice().deviceInfo()).firmware || '');
              const [maj, min] = fw.split('.').map(Number);
              info.supported = maj > 15 || (maj === 15 && min >= 2);
              info.firmware = fw;
            } catch { info.supported = null; }
            return sendJson(res, 200, info);
          }
          if (action === 'enable' && req.method === 'POST') return sendJson(res, 200, await pf.ensureEnabled());
          if (action === 'start' && req.method === 'POST') return sendJson(res, 200, await pf.start());
          if (action === 'stop' && req.method === 'POST') return sendJson(res, 200, await pf.stop());
          if (action === 'heap-snapshot' && req.method === 'POST') return sendJson(res, 200, await pf.heapSnapshot());
          if (action === 'download') {
            const full = pf.safeFile(url.searchParams.get('file'));
            res.writeHead(200, {
              'Content-Type': 'application/octet-stream',
              'Content-Disposition': `attachment; filename="${path.basename(full)}"`,
            });
            return fs.createReadStream(full).pipe(res);
          }
        } catch (e) { return sendJson(res, 502, { error: e.message }); }
        return sendJson(res, 404, { error: 'unknown perfetto action' });
      }
      if (p === '/api/perf/bsprof' && req.method === 'POST') {
        // Import a .bsprof produced by Roku's BrightScript Profiler (raw binary body).
        const buf = await readRawBody(req, 64 * 1024 * 1024);
        try { return sendJson(res, 200, bsprof.parse(buf)); }
        catch (e) { return sendJson(res, 400, { error: `could not parse .bsprof: ${e.message}` }); }
      }
      if (p === '/api/perf/bsprof-pull') {
        // With manifest `bsprof_data_dest=network`, the device streams the profile on port 8090.
        // Best-effort: a channel without profiling enabled simply refuses the connection.
        const h = current.host;
        if (!h) return sendJson(res, 400, { error: 'no device connected' });
        if (!(await gate(true))) return;
        try {
          // Share the device's queue lane so the pull never overlaps ECP polls (ROB-01b); one attempt only.
          const r = await defaultQueue.run(queueKey(h), 'other', async () => {
            const resp = await fetch(`http://${h}:8090/bsprof/channel.bsprof`, { signal: AbortSignal.timeout(15000) });
            return { status: resp.status, ok: resp.ok, buf: resp.ok ? new Uint8Array(await resp.arrayBuffer()) : null };
          }, { idempotent: false });
          if (!r.ok) return sendJson(res, 502, { error: `device answered HTTP ${r.status}` });
          const buf = r.buf;
          return sendJson(res, 200, bsprof.parse(buf));
        } catch (e) {
          return sendJson(res, 502, {
            error: `could not pull profile from ${h}:8090 — is the channel built with bsprof_enable=1 and bsprof_data_dest=network? (${e.message})`,
          });
        }
      }
      if (p === '/api/launch' && req.method === 'POST') {
        if (!(await gate(true))) return;
        const { app: appId, contentId, mediaType } = await readBody(req);
        await device.launch(appId || app || 'dev', contentId ? { contentId, mediaType } : {});
        return sendJson(res, 200, { ok: true });
      }
      serveStatic(res, p);
    } catch (e) {
      sendJson(res, 502, { error: e.message, code: e.code || null });
    }
  });

  // Bind the first free port of `ports` (one port when --port was given). A port in use by another
  // process fails fast with an error naming that process.
  const ports = [port, ...(portFallback || [])];
  return new Promise((resolve, reject) => {
    const closeServer = server.close.bind(server);
    server.close = (...a) => { summaryPool.terminateAll(); return closeServer(...a); };
    server.on('close', () => { summaryPool.terminateAll(); clearInterval(leaseTimer); for (const stop of [...netStreams]) stop(); sl.cancel(); sl.release('studio stopped'); if (hubCtl) hubCtl.stop(); });
    const tryPort = (i) => {
      const onError = (e) => {
        server.removeListener('listening', onListening);
        if (e.code === 'EADDRINUSE' && i + 1 < ports.length) return tryPort(i + 1);
        clearInterval(leaseTimer);
        if (e.code === 'EADDRINUSE') {
          const who = portHolder(ports[i]);
          const tried = ports.length > 1 ? `ports ${ports[0]}-${ports[ports.length - 1]} are` : `port ${ports[i]} is`;
          const err = new Error(`${tried} in use${who ? ` (port ${ports[i]}: ${who})` : ''}; pass a free one with --port <n>`);
          err.code = 'EADDRINUSE'; err.port = ports[i]; err.holder = who;
          return reject(err);
        }
        reject(e);
      };
      const onListening = async () => {
        server.removeListener('error', onError);
        sl.port = server.address().port;
        if (app && (device || sl.pool)) {
          if (await sl.ensure({ user: true })) device.launch(app, {}).catch(() => {});
          else sl.log(`[brighttest lease] ${host || 'every pool device'} is in use; not launching ${app} (see brighttest device status)`);
        }
        resolve(server);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(ports[i], '127.0.0.1');
    };
    tryPort(0);
  });
}

// Which process listens on a local TCP port ("pid 123 (node)"), from the OS; null when unknown.
function portHolder(port) {
  try {
    const { spawnSync } = require('child_process');
    if (process.platform === 'win32') {
      const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 3000 });
      const line = (r.stdout || '').split(/\r?\n/).find((l) => new RegExp(`:${port}\\s+\\S+\\s+LISTENING`).test(l));
      const pid = line && line.trim().split(/\s+/).pop();
      return pid ? `pid ${pid}` : null;
    }
    const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { encoding: 'utf8', timeout: 3000 });
    const pid = /^p(\d+)/m.exec(r.stdout || '');
    const cmd = /^c(.+)$/m.exec(r.stdout || '');
    return pid ? `pid ${pid[1]}${cmd ? ` (${cmd[1]})` : ''}` : null;
  } catch { return null; }
}

module.exports = { memberPassword, start, coalesce, portHolder, resolveStudioTarget };
