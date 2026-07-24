'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createDevice } = require('../e2e/ecp');
const devices = require('../devices');
const sg = require('../e2e/sgnodes');
const flowLib = require('../e2e/flow');
const { execStep } = require('../e2e/run');
const coords = require('./coords');

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

// Recent run traces for the time-travel viewer: a screenshot + resolved tree per step, kept in memory so
// any recent run can be scrubbed. Capped to the last MAX_RUNS to bound memory.
let traceSeq = 0;
const MAX_RUNS = 12;
const runs = []; // oldest → newest
const findRun = (id) => runs.find((r) => r.id === id);

// Run a flow on the device, streaming per-step results to the browser over Server-Sent Events. Reuses the
// e2e runner's execStep so studio playback matches `brighttest e2e run` exactly. After each step it captures
// a frame (screenshot) + the node tree into the run's trace so it can be scrubbed later. Stops at first fail.
async function runFlowSSE(res, full, rel, device, app) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  let flow;
  try { flow = flowLib.loadFlow(full); }
  catch (e) { send({ type: 'error', error: e.message }); return res.end(); }

  const ctx = {
    device,
    stepTimeoutMs: (flow.config && flow.config.timeout ? flow.config.timeout : 10) * 1000,
    opts: { app }, flow, launchParams: {},
  };
  const runId = ++traceSeq;
  const run = { id: runId, flow: rel || path.basename(full), startedAt: Date.now(), ok: null, steps: [], frames: new Map() };
  runs.push(run);
  while (runs.length > MAX_RUNS) { const old = runs.shift(); old.frames.clear(); }

  send({ type: 'start', runId, flow: run.flow, steps: flow.steps.map((s, i) => ({ index: i, op: s.op, line: s.line })) });

  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    send({ type: 'step', index: i, op: step.op, status: 'running', selector: step.selector || null });

    let status = 'pass', detail = '', error = null;
    try { const r = await execStep(step, ctx); detail = (r && r.detail) || ''; }
    catch (e) { status = 'fail'; error = e.message; }

    // Capture the resulting state for the trace (best-effort — a capture failure never fails the run).
    let scene = null, nodes = null;
    try { const tree = await sg.fetchTree(device, { retries: 2, backoffMs: 150 }); scene = coords.sceneSize(tree.roots); nodes = coords.resolveAbsolute(tree.roots); } catch {}
    // The dev screenshot endpoint 404s momentarily during transitions — retry once so fewer steps are frameless.
    for (let a = 0; a < 2 && !run.frames.has(i); a++) {
      try { const shot = await device.screenshot(); run.frames.set(i, shot.buffer); }
      catch { await new Promise((r) => setTimeout(r, 300)); }
    }

    const rec = { index: i, op: step.op, status, detail: error || detail, selector: step.selector || null, scene, nodes, frame: run.frames.has(i) };
    run.steps.push(rec);
    send({ type: 'step', ...rec, error, runId });
    if (status === 'fail') { run.ok = false; send({ type: 'done', ok: false, runId }); return res.end(); }
  }
  run.ok = true;
  send({ type: 'done', ok: true, runId });
  res.end();
}

// Start the studio server. Returns the http.Server (for tests/shutdown). `rootDir`/`flowsDir` scope the
// real project flow files the studio reads and writes (defaults: cwd and cwd/flows).
function start({ host, password, port = 8700, app = null, rootDir = process.cwd(), flowsDir = null } = {}) {
  // The active device can be (re)connected at runtime from the Devices page, so it's mutable.
  let device = host ? createDevice({ host, password }) : null;
  const current = { host: host || null };
  if (host) devices.rememberDevice(host, password);
  const flowsRoot = path.resolve(rootDir, flowsDir || 'flows');
  const needDevice = () => { if (!device) throw Object.assign(new Error('no device connected'), { code: 'NO_DEVICE' }); return device; };
  // Independent coalesced lanes: the fast tree read never queues behind the slow screenshot. Fewer sgnodes
  // retries than the e2e default so a stale read fails fast and the next poll (≈300ms later) tries again.
  const getTree = coalesce(() => sg.fetchTree(needDevice(), { retries: 3, backoffMs: 150 }));
  const getShot = coalesce(() => needDevice().screenshot());

  // Resolve a client-supplied flow path against flowsRoot; refuse anything escaping it (path traversal).
  const safeFlow = (rel, requireYaml) => {
    const full = path.resolve(flowsRoot, rel || '');
    if (full !== flowsRoot && !full.startsWith(flowsRoot + path.sep)) { const e = new Error('path outside flows dir'); e.code = 'EPATH'; throw e; }
    if (requireYaml && !/\.e2e\.ya?ml$/i.test(full)) { const e = new Error('only *.e2e.yaml files can be saved'); e.code = 'EPATH'; throw e; }
    return full;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (p === '/api/device') {
        if (!device) return sendJson(res, 200, { connected: false });
        try { return sendJson(res, 200, { connected: true, host: current.host, ...(await device.deviceInfo()) }); }
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
          devices.rememberDevice(h, secret, info.model);
          if (app) device.launch(app, {}).catch(() => {});
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
        const rel = url.searchParams.get('file');
        return runFlowSSE(res, safeFlow(rel), rel, device, app);
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
        const runParam = url.searchParams.get('run');
        const store = runParam ? (findRun(Number(runParam)) || {}).frames : (runs.length ? runs[runs.length - 1].frames : null);
        const buf = store && store.get(step);
        if (!buf) { res.writeHead(404); return res.end('no frame'); }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
        return res.end(buf);
      }
      if (p === '/api/tree') {
        const tree = await getTree();
        return sendJson(res, 200, { scene: coords.sceneSize(tree.roots), nodes: coords.resolveAbsolute(tree.roots) });
      }
      if (p === '/api/screenshot') {
        const shot = await getShot();
        res.writeHead(200, { 'Content-Type': shot.ext === 'png' ? 'image/png' : 'image/jpeg', 'Cache-Control': 'no-store' });
        return res.end(shot.buffer);
      }
      if (p === '/api/keypress' && req.method === 'POST') {
        const { key, count } = await readBody(req);
        await device.keypressSeq(String(key), Number(count) || 1);
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/launch' && req.method === 'POST') {
        const { app: appId, contentId, mediaType } = await readBody(req);
        await device.launch(appId || app || 'dev', contentId ? { contentId, mediaType } : {});
        return sendJson(res, 200, { ok: true });
      }
      serveStatic(res, p);
    } catch (e) {
      sendJson(res, 502, { error: e.message, code: e.code || null });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      if (app) device.launch(app, {}).catch(() => {});
      resolve(server);
    });
  });
}

module.exports = { start, coalesce };
