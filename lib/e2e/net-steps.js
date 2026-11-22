'use strict';
const fs = require('fs');
const path = require('path');
const rules = require('../instrument/net-rules');
const { createNetProxy } = require('../instrument/net-proxy');

// Flow steps for network interception (NET-N-T9; design network-interception.md 4.7):
//   mockHttp, waitForRequest, assertRequest, recordHttp, clearHttp, plus the flow's `config.net`.
// The logic lives here so run.js only dispatches. Everything runs in-process against the proxy that the hub (started
// under the device lease, NET-N-T8) mounts: rules go straight into its rule set, the request log is read from the
// proxy, so the steps cost no ECP traffic and take no second lease.
//
// Scope: rules added by steps are tagged `flow:<name>` and dropped when the flow ends (or at `clearHttp`); the
// request log is cut at flow start, so earlier flows' requests are never seen. Fixtures named in `config.net.fixtures`
// are loaded the same way (flow-scoped), so one flow's fixtures never leak into the next.

const NET_OPS = new Set(['mockHttp', 'waitForRequest', 'assertRequest', 'recordHttp', 'clearHttp']);
const NET_CONFIG_KEYS = ['fixtures', 'unmatched', 'record', 'upstreamHosts', 'redact'];
const RULE_KEYS = ['id', 'method', 'url', 'reqHeaders', 'reqBody', 'times', 'status', 'headers', 'body', 'json', 'file', 'bodyBase64',
  'delayMs', 'fault', 'kind', 'holdMs', 'partialBytes', 'responses', 'passthrough'];
const MATCH_KEYS = ['method', 'url', 'status', 'bodyContains'];
const HANDSHAKE_MS = 5000;
const POLL_MS = 50;
const HANDSHAKE_ERROR = 'no agent.hello/BT_url handshake seen: build with `brighttest instrument build --net`';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
// The flow parser leaves block-style maps wrapped as { __scalar }; flatten them.
function deepUnwrap(v) {
  if (Array.isArray(v)) return v.map(deepUnwrap);
  if (isObj(v)) {
    if ('__scalar' in v) return deepUnwrap(v.__scalar);
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = deepUnwrap(x);
    return out;
  }
  return v;
}

// ---- parse time ----------------------------------------------------------------------------------

// Validate and return a clean `config.net`. Throws `Err` (the flow parser's FlowError) with a clear message.
function validateConfig(raw, Err) {
  const net = deepUnwrap(raw);
  if (!isObj(net)) throw new Err('config.net must be a map, e.g. net: { fixtures: [fixtures/net/home.json], unmatched: fail }');
  for (const k of Object.keys(net)) {
    if (!NET_CONFIG_KEYS.includes(k)) throw new Err(`config.net: unknown key "${k}" (allowed: ${NET_CONFIG_KEYS.join(', ')})`);
  }
  if (net.fixtures !== undefined && !(Array.isArray(net.fixtures) && net.fixtures.every((f) => typeof f === 'string' && f))) {
    throw new Err('config.net.fixtures must be a list of file paths (relative to the project root)');
  }
  if (net.unmatched !== undefined && net.unmatched !== 'fail' && net.unmatched !== 'passthrough') {
    throw new Err('config.net.unmatched must be "fail" or "passthrough"');
  }
  if (net.record !== undefined && typeof net.record !== 'boolean') throw new Err('config.net.record must be true or false');
  if (net.upstreamHosts !== undefined && !(Array.isArray(net.upstreamHosts) && net.upstreamHosts.every((h) => typeof h === 'string' && h))) {
    throw new Err('config.net.upstreamHosts must be a list of host names');
  }
  if (net.redact !== undefined && !isObj(net.redact)) throw new Err('config.net.redact must be a map');
  if (net.record === true && !(net.upstreamHosts && net.upstreamHosts.length)) {
    throw new Err('config.net.record requires config.net.upstreamHosts (refusing to record without an allow-list)');
  }
  return net;
}

function pickMatch(a, line, op, Err) {
  for (const k of Object.keys(a)) {
    if (!MATCH_KEYS.includes(k) && !(k === 'timeout' && op !== 'assertRequest') && !(k === 'count' && op === 'assertRequest') && !(k === 'timeout' && op === 'assertRequest')) {
      throw new Err(`line ${line}: ${op}: unknown key "${k}"`);
    }
  }
  if (typeof a.url !== 'string' || !a.url) throw new Err(`line ${line}: ${op} needs url: <glob>, e.g. ${op}: { url: "**/v1/home" }`);
  if (a.method !== undefined && !/^[A-Za-z]+$/.test(String(a.method))) throw new Err(`line ${line}: ${op}: bad method ${JSON.stringify(a.method)}`);
  if (a.status !== undefined && !Number.isInteger(a.status)) throw new Err(`line ${line}: ${op}: status must be an integer`);
  try { rules.compileUrlPattern(a.url); } catch (e) { throw new Err(`line ${line}: ${op}: ${e.message}`); }
  const m = { url: a.url };
  if (a.method !== undefined) m.method = String(a.method).toUpperCase();
  if (a.status !== undefined) m.status = a.status;
  if (a.bodyContains !== undefined) m.bodyContains = String(a.bodyContains);
  if (a.timeout !== undefined) {
    if (!Number.isFinite(Number(a.timeout)) || Number(a.timeout) < 0) throw new Err(`line ${line}: ${op}: timeout is in seconds, a non-negative number`);
    m.timeout = Number(a.timeout);
  }
  return m;
}

// Turn `key: arg` (arg null for a bare step) into a normalized step, or throw a line-referenced `Err`.
function normalizeStep(key, arg, line, Err) {
  switch (key) {
    case 'mockHttp': {
      if (!isObj(arg)) throw new Err(`line ${line}: mockHttp needs a rule map, e.g. mockHttp: { url: "**/v1/home", status: 200, file: fixtures/net/home.json }`);
      for (const k of Object.keys(arg)) if (!RULE_KEYS.includes(k)) throw new Err(`line ${line}: mockHttp: unknown key "${k}"`);
      if (typeof arg.url !== 'string' || !arg.url) throw new Err(`line ${line}: mockHttp needs url: <glob>`);
      try { rules.createRuleSet().add({ ...arg }); } catch (e) {
        if (e && e.name === 'NetRuleError') throw new Err(`line ${line}: mockHttp: ${e.message}`);
        throw e;
      }
      return { op: 'mockHttp', line, rule: { ...arg } };
    }
    case 'waitForRequest':
    case 'assertRequest': {
      if (!isObj(arg)) throw new Err(`line ${line}: ${key} needs a map, e.g. ${key}: { url: "**/v1/home" }`);
      const m = pickMatch(arg, line, key, Err);
      const step = { op: key, line, match: m, timeout: m.timeout };
      delete m.timeout;
      if (key === 'assertRequest' && arg.count !== undefined) {
        if (!Number.isInteger(arg.count) || arg.count < 0) throw new Err(`line ${line}: assertRequest: count must be an integer >= 0`);
        step.count = arg.count;
      }
      return step;
    }
    case 'recordHttp': {
      if (arg === 'stop' || (isObj(arg) && arg.stop === true && arg.file === undefined)) return { op: 'recordHttp', line, stop: true };
      if (!isObj(arg) || typeof arg.file !== 'string' || !arg.file) throw new Err(`line ${line}: recordHttp needs { file: <path.har> } or the value stop`);
      return { op: 'recordHttp', line, file: arg.file };
    }
    case 'clearHttp':
      if (arg !== null && arg !== undefined && !(isObj(arg) && !Object.keys(arg).length)) throw new Err(`line ${line}: clearHttp takes no arguments`);
      return { op: 'clearHttp', line };
    default:
      throw new Err(`line ${line}: unknown step "${key}"`);
  }
}

function usesNet(flow) {
  return !!(flow && ((flow.config && flow.config.net) || (flow.steps || []).some((s) => NET_OPS.has(s.op))));
}

// ---- run time ------------------------------------------------------------------------------------

// Built once per host before the hub starts: the proxy the hub will mount, sized from every flow in the run. Returns
// null when no flow uses network features. Flows that fail to load are ignored here (they fail on their own).
function planSession(units, cfg, loadFlow, emit) {
  const flows = [];
  for (const u of units) { try { const f = loadFlow(u.file); if (usesNet(f)) flows.push(f); } catch { /* reported when the unit runs */ } }
  if (!flows.length) return null;
  const hosts = [];
  for (const f of flows) for (const h of (f.config.net && f.config.net.upstreamHosts) || []) if (!hosts.includes(h)) hosts.push(h);
  const wantsRecord = flows.some((f) => (f.config.net && f.config.net.record) || f.steps.some((s) => s.op === 'recordHttp'));
  const record = wantsRecord && hosts.length > 0;
  const netDir = path.join(cfg.stagingDir, 'net');
  const proxy = createNetProxy({
    ...(emit ? { emit } : {}), root: cfg.rootDir, upstreamHosts: hosts, record, bodyDir: path.join(netDir, 'bodies'),
    redact: (flows.find((f) => f.config.net && f.config.net.redact) || { config: { net: {} } }).config.net.redact || {},
  });
  return { proxy, record, close() { proxy.close(); } };
}

// Per-flow setup. Returns { net } (null when the flow uses no network features), or { error } to fail the unit before
// the device is touched (no hub, bad fixtures).
function beginFlow(flow, session, hub, cfg) {
  if (!usesNet(flow)) return { net: null };
  if (!session || !hub) {
    return { error: 'network steps need the instrument hub, which is not running (the device lease was bypassed or the hub failed to start; see the lines above)' };
  }
  const { proxy } = session;
  const scope = `flow:${flow.name || 'flow'}`;
  const nc = flow.config.net || {};
  try {
    // First match wins in a fixture file; rules are prepended, so add them in reverse to keep the file's order.
    const files = require('../instrument/net-headless').expandFixtures(cfg.rootDir, nc.fixtures);
    for (const f of files.slice().reverse()) {
      const loaded = rules.loadRulesFile(f);
      const arr = Array.isArray(loaded) ? loaded : [loaded];
      for (let i = arr.length - 1; i >= 0; i--) proxy.ruleSet.add(arr[i], { scope });
    }
    proxy.setUnmatched(nc.unmatched || (files.length ? 'fail' : 'passthrough'));
  } catch (e) {
    if (e && e.name === 'NetRuleError') return { error: `config.net: ${e.message}` };
    throw e;
  }
  return {
    net: {
      session, hub, proxy, scope, root: cfg.rootDir, recording: null, handshook: false,
      hidden: new Set(proxy.requests().map((e) => e.id)), helloBase: hub.hellos || 0,
    },
  };
}

// Stop the proxy's recording window and write its HAR. The window is closed even if writing fails, so recording
// never stays on; a proxy overflow error surfaces as the message.
function writeRecording(net) {
  const rec = net.recording;
  net.recording = null;
  const har = net.proxy.stopRecording();
  const file = path.resolve(net.root, rec.file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(har, null, 2));
  return { file, count: har.log.entries.length };
}

// Flow end: drop this flow's rules, finish an open recording. Never throws.
function endFlow(net, write = () => {}) {
  if (!net) return;
  try { net.proxy.ruleSet.reset({ scope: net.scope }); } catch { /* best-effort */ }
  if (net.recording) {
    try { const r = writeRecording(net); write(`  recordHttp: ${r.count} request(s) written to ${r.file} (flow ended)\n`); } catch (e) { write(`  recordHttp: could not write HAR: ${e.message}\n`); }
  }
}

// After `launch`: a build without the instrument runtime never dials the hub. Fail now, not after step timeouts.
async function awaitHandshake(ctx) {
  const net = ctx.net;
  if (!net || net.handshook) return;
  const limit = (ctx.opts && ctx.opts.netHandshakeMs) || HANDSHAKE_MS;
  const deadline = Date.now() + limit;
  for (;;) {
    if ((net.hub.hellos || 0) > net.helloBase) { net.handshook = true; return; }
    if (ctx.signal && ctx.signal.aborted) throw new Error(String(ctx.signal.reason || 'aborted'));
    if (Date.now() >= deadline) throw new Error(HANDSHAKE_ERROR);
    await sleep(POLL_MS);
  }
}

function describe(m) {
  return `${m.method || 'ANY'} ${m.url}${m.status !== undefined ? ` -> ${m.status}` : ''}${m.bodyContains !== undefined ? ` with body containing ${JSON.stringify(m.bodyContains)}` : ''}`;
}

function logSummary(net) {
  const all = net.proxy.requests().filter((e) => !net.hidden.has(e.id));
  if (!all.length) return 'the request log is empty';
  const label = (e) => { let p = e.url; try { p = new URL(e.url).pathname; } catch { p = String(e.url).split(/[?#]/)[0]; } return `${e.method} ${p}`; };
  const shown = all.slice(0, 5).map(label).join(', ');
  return `${all.length} request(s) in the log: ${shown}${all.length > 5 ? ', ...' : ''}`;
}

function matches(net, m) {
  const filter = { url: m.url };
  if (m.method) filter.method = m.method;
  if (m.status !== undefined) filter.status = m.status;
  return net.proxy.requests(filter)
    .filter((e) => !net.hidden.has(e.id))
    .filter((e) => m.bodyContains === undefined || String(e.body || '').includes(m.bodyContains));
}

async function pollUntil(ctx, fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (ctx.signal && ctx.signal.aborted) throw new Error(String(ctx.signal.reason || 'aborted'));
    if (Date.now() >= deadline) return null;
    await sleep(POLL_MS);
  }
}

// Execute one network step. Returns { detail }; throws Error with the message shown to the user.
async function execStep(step, ctx) {
  const net = ctx.net;
  if (!net) throw new Error(`${step.op}: network steps need the instrument hub and an instrumented build (brighttest instrument build --net); no hub is running for this flow`);
  switch (step.op) {
    case 'mockHttp': {
      let id;
      try { id = net.proxy.ruleSet.add({ ...step.rule }, { scope: net.scope }); } catch (e) {
        if (e && e.name === 'NetRuleError') throw new Error(`mockHttp: ${e.message}`);
        throw e;
      }
      return { detail: `${step.rule.method || 'ANY'} ${step.rule.url} (${id})` };
    }
    case 'waitForRequest': {
      const timeout = step.timeout !== undefined ? step.timeout * 1000 : ctx.stepTimeoutMs;
      const hit = await pollUntil(ctx, () => matches(net, step.match)[0] || null, timeout);
      if (!hit) throw new Error(`waitForRequest: no request matching ${describe(step.match)} within ${timeout / 1000}s (${logSummary(net)})`);
      return { detail: `${hit.method} ${describe({ url: step.match.url })}` };
    }
    case 'assertRequest': {
      const want = step.count;
      const timeout = step.timeout !== undefined ? step.timeout * 1000 : ctx.stepTimeoutMs;
      let seen = 0;
      const ok = await pollUntil(ctx, () => {
        seen = matches(net, step.match).length;
        if (want === undefined) return seen >= 1;
        if (want === 0) return seen === 0; // a negative check cannot wait for "later"; it passes on the current log
        if (seen > want) throw new Error(`assertRequest: expected ${want} request(s) matching ${describe(step.match)}, saw ${seen} (${logSummary(net)})`);
        return seen === want;
      }, timeout);
      if (!ok) {
        const exp = want === undefined ? 'at least 1' : String(want);
        throw new Error(`assertRequest: expected ${exp} request(s) matching ${describe(step.match)}, saw ${seen} (${logSummary(net)})`);
      }
      return { detail: `${seen} x ${describe(step.match)}` };
    }
    case 'recordHttp': {
      if (step.stop) {
        if (!net.recording) throw new Error('recordHttp: stop without an active recording (start one with recordHttp: { file: out.har })');
        const r = writeRecording(net);
        return { detail: `${r.count} request(s) -> ${path.relative(net.root, r.file) || r.file}` };
      }
      if (!net.session.record || !net.proxy.allowedHosts().length) {
        throw new Error('recordHttp: record refuses to start without config.net.upstreamHosts (the hosts passthrough may reach)');
      }
      try { net.proxy.startRecording(); } catch (e) {
        if (e && e.name === 'NetRuleError') throw new Error(`recordHttp: ${e.message}`);
        throw e;
      }
      net.recording = { file: step.file };
      return { detail: `recording passthrough to ${step.file}` };
    }
    case 'clearHttp': {
      net.proxy.ruleSet.reset({ scope: net.scope });
      for (const e of net.proxy.requests()) net.hidden.add(e.id);
      return { detail: 'flow rules and request log cleared' };
    }
    default:
      throw new Error(`unknown network step ${step.op}`);
  }
}

module.exports = {
  NET_OPS, HANDSHAKE_ERROR, validateConfig, normalizeStep, usesNet, planSession, beginFlow, endFlow, awaitHandshake, execStep,
};
