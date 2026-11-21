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
const { StudioLease } = require('./lease');

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
  };
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
    catch (e) { status = 'fail'; error = e.message; }
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

function start(opts = {}) {
  const { port = 8700, app = null, rootDir = process.cwd(), flowsDir = null, cfg = null, leaseOpts = {}, portFallback = null, perfettoOpts = {} } = opts;
  const { host, password } = resolveStudioTarget(opts);
  // The active device can be (re)connected at runtime from the Devices page, so it's mutable.
  let device = host ? createDevice({ host, password }) : null;
  const current = { host: host || null };
  if (host) devices.rememberDevice(host, password);
  const flowsRoot = path.resolve(rootDir, flowsDir || 'flows');
  const runsDir = path.join(rootDir, '.brighttest', 'studio', 'runs');
  try { fs.mkdirSync(runsDir, { recursive: true }); } catch {}
  loadRuns(runsDir); // restore persisted run history across restarts
  // Device lease: Studio holds it only while in use; see ./lease.js.
  const sl = new StudioLease({ host, cfg, acquireOpts: leaseOpts.acquireOpts, now: leaseOpts.now, log: leaseOpts.log });
  const needDevice = () => { if (!device) throw Object.assign(new Error('no device connected'), { code: 'NO_DEVICE' }); return device; };
  // Independent coalesced lanes: the fast tree read never queues behind the slow screenshot. Fewer sgnodes
  // retries than the e2e default so a stale read fails fast and the next poll (≈300ms later) tries again.
  const getTree = coalesce(() => sg.fetchTree(needDevice(), { retries: 3, backoffMs: 150, serveCached: true }));
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
        const tree = await getTree();
        return sendJson(res, 200, {
          ...coords.project(tree.roots, { screen: await ensureScreen(), layout: appstate.extractLayoutHints(tree.roots) }),
          appState: appstate.extractAppState(tree.roots),
          agent: agentLayers(tree.roots),
        });
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
          return sendJson(res, notFound ? 409 : 502, { error: e.message, ...(notFound ? { code: 'TARGET_NOT_FOUND', channel } : {}) });
        }
      }
      if (p.startsWith('/api/perf/perfetto/')) {
        if (!current.host) return sendJson(res, 400, { error: 'no device connected' });
        const pf = await getPerfetto();
        const action = p.slice('/api/perf/perfetto/'.length);
        if (req.method === 'POST' && !(await gate(true))) return;
        try {
          if (action === 'status') {
            const info = { ...pf.status() };
            // Perfetto needs Roku OS 15.2+ (the gate roku-debug applies).
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
    server.on('close', () => { clearInterval(leaseTimer); sl.release('studio stopped'); });
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
        if (app && device) {
          if (await sl.ensure({ user: true })) device.launch(app, {}).catch(() => {});
          else sl.log(`[brighttest lease] ${host} is in use; not launching ${app} (see brighttest device status)`);
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

module.exports = { start, coalesce, portHolder, resolveStudioTarget };
