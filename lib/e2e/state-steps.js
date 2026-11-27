'use strict';
const path = require('path');
const netSteps = require('./net-steps');
const appstate = require('./appstate');
const { entry: catalogEntry } = require('./step-catalog'); // allowed map keys come from the catalog (ADR 0047)

// Flow steps for app state (STA-S-T7; design app-state-devtools.md 4.5 and D6):
//   waitForAgent, setState (single op or `ops:` batch as one atomic command), snapshot, restore, callFunc,
//   plus the flow's `config.state.ack` (applied | reflected, default applied).
// Like the network steps, the logic lives here so run.js only dispatches. Commands go in-process to the hub that
// runHost starts under the device lease (hub.push + hub.stateOps), so the steps cost no ECP traffic and take no second
// lease. The agent answers with `cmd.ack` events; a step waits for the ack phase it asked for and reports the phase
// it reached when it fails.

const STATE_OPS = new Set(['waitForAgent', 'setState', 'snapshot', 'restore', 'callFunc']);
const ACKS = ['applied', 'reflected'];
const LAYERS = ['global', 'scene', 'node', 'm', 'registry'];
const POLL_MS = 25;
const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const FN_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Structural equality on parsed JSON values (same rule as the ECP-read assertState in run.js).
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
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

// A failure with a stable `code`: STATE_NO_HUB, STATE_NOT_INSTRUMENTED, STATE_ACK_TIMEOUT, STATE_CMD_FAILED,
// STATE_SNAPSHOT_NOT_FOUND, STATE_TOO_LARGE, STATE_BAD_COMMAND.
class StateStepError extends Error {
  constructor(code, message) { super(message); this.name = 'StateStepError'; this.code = code; }
}

const NOT_INSTRUMENTED = 'no agent.hello seen: the app build is not instrumented (build with `brighttest instrument build`, sideload it), '
  + 'or it cannot reach the hub (check instrument.hub.host/port and that BRIGHTTEST_HUB_TOKEN is the same at build and run time), '
  + 'or the app was already running from an earlier run and ignored the launch (press Home to close it and run again, so it dials this run\'s hub)';

// ---- parse time ----------------------------------------------------------------------------------

function validateConfig(raw, Err) {
  const st = deepUnwrap(raw);
  if (!isObj(st)) throw new Err('config.state must be a map, e.g. state: { ack: applied }');
  for (const k of Object.keys(st)) if (k !== 'ack') throw new Err(`config.state: unknown key "${k}" (allowed: ack)`);
  if (st.ack !== undefined && !ACKS.includes(st.ack)) throw new Err(`config.state.ack must be one of ${ACKS.join(', ')}`);
  return st;
}

function checkKeys(a, allowed, line, op, Err) {
  for (const k of Object.keys(a)) if (!allowed.includes(k)) throw new Err(`line ${line}: ${op}: unknown key "${k}" (allowed: ${allowed.join(', ')})`);
}
function checkAck(a, line, op, Err) {
  if (a.ack !== undefined && !ACKS.includes(a.ack)) throw new Err(`line ${line}: ${op}: ack must be one of ${ACKS.join(', ')}`);
}
function checkTimeout(a, line, op, Err) {
  if (a.timeout !== undefined && !(Number.isFinite(Number(a.timeout)) && Number(a.timeout) > 0)) {
    throw new Err(`line ${line}: ${op}: timeout is in seconds, a positive number (omit it for the step default)`);
  }
}
function checkNode(n, line, op, Err) {
  if (!isObj(n) || typeof n.id !== 'string' || !n.id || Object.keys(n).some((k) => k !== 'id')) {
    throw new Err(`line ${line}: ${op}: node must be { id: <node id> }`);
  }
  return { id: n.id };
}
function checkPath(p, line, op, Err) {
  if (typeof p !== 'string' || !p || /(^\.|\.$|\.\.)/.test(p)) throw new Err(`line ${line}: ${op}: path must be a dotted path like user.tier`);
  return p;
}
function common(a) {
  const out = {};
  if (a.ack !== undefined) out.ack = a.ack;
  if (a.timeout !== undefined) out.timeout = Number(a.timeout);
  return out;
}

// Turn `key: arg` (arg null for a bare step) into a normalized step, or throw a line-referenced `Err`.
function normalizeStep(key, arg0, line, Err) {
  const arg = deepUnwrap(arg0);
  switch (key) {
    case 'waitForAgent': {
      if (arg === null || arg === undefined) return { op: 'waitForAgent', line };
      if (!isObj(arg)) throw new Err(`line ${line}: waitForAgent takes no value or a map, e.g. waitForAgent: { timeout: 10 }`);
      checkKeys(arg, catalogEntry(key).keys, line, key, Err); checkTimeout(arg, line, key, Err);
      return { op: 'waitForAgent', line, ...common(arg) };
    }
    case 'setState': {
      if (!isObj(arg)) throw new Err(`line ${line}: setState needs a map, e.g. setState: { layer: global, path: user.tier, value: premium }`);
      checkKeys(arg, catalogEntry(key).keys, line, key, Err);
      const layer = arg.layer === undefined ? 'global' : arg.layer;
      if (!LAYERS.includes(layer)) throw new Err(`line ${line}: setState: layer must be one of ${LAYERS.join(', ')} (got ${JSON.stringify(layer)})`);
      checkAck(arg, line, key, Err); checkTimeout(arg, line, key, Err);
      const step = { op: 'setState', line, layer, ...common(arg) };
      if (layer === 'node' || layer === 'm') step.node = checkNode(arg.node, line, key, Err);
      else if (arg.node !== undefined) throw new Err(`line ${line}: setState: node only applies to layer: node or m`);
      if (arg.ops !== undefined) {
        if (arg.path !== undefined || 'value' in arg) throw new Err(`line ${line}: setState: ops cannot be combined with path or value`);
        if (layer === 'registry') throw new Err(`line ${line}: setState: ops is not supported for layer registry (registry writes are one key at a time)`);
        if (!Array.isArray(arg.ops) || !arg.ops.length) throw new Err(`line ${line}: setState: ops must be a non-empty list of { path, value }`);
        step.ops = arg.ops.map((o, i) => {
          if (!isObj(o)) throw new Err(`line ${line}: setState: ops[${i}] must be { path, value }`);
          checkKeys(o, ['path', 'value'], line, `setState ops[${i}]`, Err);
          if (!('value' in o)) throw new Err(`line ${line}: setState: ops[${i}] needs a value`);
          return { path: checkPath(o.path, line, `setState ops[${i}]`, Err), value: o.value };
        });
        return step;
      }
      step.path = checkPath(arg.path, line, key, Err);
      if (!('value' in arg)) throw new Err(`line ${line}: setState needs a value (or ops: [...])`);
      if (layer === 'registry' && !/^[^.]+\..+$/.test(step.path)) throw new Err(`line ${line}: setState: a registry path is <section>.<key>, e.g. openCinema.watchlist`);
      step.value = arg.value;
      return step;
    }
    case 'snapshot':
    case 'restore': {
      const a = typeof arg === 'string' || typeof arg === 'number' ? { name: String(arg) } : arg;
      if (!isObj(a)) throw new Err(`line ${line}: ${key} needs a name, e.g. ${key}: fresh_home`);
      checkKeys(a, catalogEntry(key).keys, line, key, Err);
      checkAck(a, line, key, Err); checkTimeout(a, line, key, Err);
      if (typeof a.name !== 'string' || !NAME_RE.test(a.name)) throw new Err(`line ${line}: ${key}: name must be letters, digits, "_", "-" or "."`);
      const step = { op: key, line, name: a.name, ...common(a) };
      if (a.nodes !== undefined) {
        if (!Array.isArray(a.nodes) || !a.nodes.length || a.nodes.some((id) => typeof id !== 'string' || !id)) {
          throw new Err(`line ${line}: ${key}: nodes must be a non-empty list of node ids, e.g. nodes: [tierLabel]`);
        }
        step.nodes = [...new Set(a.nodes)];
      }
      return step;
    }
    case 'callFunc': {
      if (!isObj(arg)) throw new Err(`line ${line}: callFunc needs a map, e.g. callFunc: { node: { id: homePanel }, fn: bt_resetHome, args: [] }`);
      checkKeys(arg, catalogEntry(key).keys, line, key, Err); checkAck(arg, line, key, Err); checkTimeout(arg, line, key, Err);
      const node = checkNode(arg.node, line, key, Err);
      if (typeof arg.fn !== 'string' || !FN_RE.test(arg.fn)) throw new Err(`line ${line}: callFunc: fn must be a function name like bt_resetHome`);
      if (arg.args !== undefined && !Array.isArray(arg.args)) throw new Err(`line ${line}: callFunc: args must be a list`);
      if (arg.args && arg.args.length > 1) throw new Err(`line ${line}: callFunc: at most one argument is passed (the agent calls the function with args[0] only); pass an object to send several values`);
      // The allow-list (instrument.state.callable) lives in brighttest.json, so names are checked against it when the
      // flow starts (beginFlow), before the flow's first step runs.
      return { op: 'callFunc', line, node, fn: arg.fn, args: arg.args || [], ...common(arg) };
    }
    default:
      throw new Err(`line ${line}: unknown step "${key}"`);
  }
}

// The hub command for a normalized setState step: { op, args }. Shared with Studio's state inspector (same rules).
function setStateCommand(step) {
  if (step.layer === 'registry') {
    const dot = step.path.indexOf('.');
    return { op: 'registry.write', args: { section: step.path.slice(0, dot), key: step.path.slice(dot + 1), value: step.value } };
  }
  const args = { layer: step.layer };
  if (step.node) args.node = step.node;
  if (step.ops) args.ops = step.ops; else { args.path = step.path; args.value = step.value; }
  return { op: 'set', args };
}

// assertState with layer node|m reads one node through the hub `get` op (the other layers read the agent node over ECP).
function isNodeAssert(s) { return !!s && s.op === 'assertState' && (s.layer === 'node' || s.layer === 'm'); }

function usesState(flow) {
  return !!(flow && ((flow.config && flow.config.state) || (flow.steps || []).some((s) => STATE_OPS.has(s.op) || isNodeAssert(s))));
}

// ---- run time ------------------------------------------------------------------------------------

// True when any flow in the run needs the hub for state steps. Flows that fail to load are reported when they run.
function planSession(units, loadFlow) {
  for (const u of units) { try { if (usesState(loadFlow(u.file))) return true; } catch { /* reported when the unit runs */ } }
  return false;
}

function callableList(cfg) {
  const s = cfg && cfg.instrument && cfg.instrument.state;
  return s && Array.isArray(s.callable) ? s.callable : [];
}

// Per-flow setup. `label` is the run unit's label (param units of one file get their own snapshot scope). Returns
// { state } (null when the flow uses no state features), or { error } to fail the unit before its first step runs
// (no hub, a callFunc outside the allow-list). opts.helloBase: count hellos from this value instead of the hub's current
// count (the MCP session window passes 0 so a call sees the window hub's earlier hello); e2e run passes nothing.
function beginFlow(flow, hub, cfg, label, opts = {}) {
  if (!usesState(flow)) return { state: null };
  if (!hub) {
    return { error: 'state steps need the instrument hub, which is not running (the device lease was bypassed or the hub failed to start; see the lines above)' };
  }
  // Same rule as the runtime (BT_wCallFunc): only names in instrument.state.callable, compared ignoring case.
  const allowed = callableList(cfg).map((n) => String(n).toLowerCase());
  for (const s of flow.steps || []) {
    if (s.op === 'callFunc' && !allowed.includes(s.fn.toLowerCase())) {
      return { error: `line ${s.line}: callFunc: "${s.fn}" is not in instrument.state.callable in brighttest.json (the agent runs only listed names; rebuild after adding one)` };
    }
  }
  const ack = (flow.config && flow.config.state && flow.config.state.ack) || 'applied';
  const scope = `${path.resolve(flow.file || flow.name || 'flow')}|${label || ''}`;
  return { state: { hub, ack, scope, snapshots: new Set(), helloBase: opts.helloBase !== undefined ? opts.helloBase : (hub.hellos || 0), handshook: false } };
}

// Flow end: drop this flow's snapshots from the hub store (it keeps at most 20 for the whole run). Never throws.
function endFlow(st) {
  if (!st) return;
  for (const k of st.snapshots) { try { st.hub.stateOps.deleteSnapshot(k); } catch { /* best-effort */ } }
  st.snapshots.clear();
}

// After `launch`: a build without the agent never dials the hub. Fail now, with a typed error, not after step timeouts.
async function awaitHandshake(ctx) {
  const st = ctx.state;
  if (!st || st.handshook) return;
  try { await netSteps.awaitHandshake({ ...ctx, net: st }); } catch (e) {
    if (e && e.message === netSteps.HANDSHAKE_ERROR) throw new StateStepError('STATE_NOT_INSTRUMENTED', NOT_INSTRUMENTED);
    throw e;
  }
}

function aborted(ctx) { return ctx.signal && ctx.signal.aborted ? new Error(String(ctx.signal.reason || 'aborted')) : null; }
const helloSeen = (st) => (st.hub.hellos || 0) > st.helloBase;

// Queue one command and wait for the ack phase it asked for. Returns the tracked command ({ phase, result, ... }).
async function send(step, ctx, op, args) {
  const st = ctx.state;
  const ack = step.ack || st.ack;
  let draft;
  try { draft = st.hub.stateOps.prepare({ op, args, ack }); } catch (e) {
    throw new StateStepError(e && e.code === 'STATE_TOO_LARGE' ? 'STATE_TOO_LARGE' : 'STATE_BAD_COMMAND', `${step.op}: ${e.message}`);
  }
  const full = st.hub.push({ op: draft.op, args: draft.args, ack: draft.ack }, { ack: draft.ack });
  const limit = step.timeout !== undefined ? step.timeout * 1000 : ctx.stepTimeoutMs;
  const deadline = Date.now() + limit;
  for (;;) {
    const c = st.hub.stateOps.get(full.id);
    if (c && c.status === 'done') return c;
    // The hub marks a command `timeout` on its own (shorter) limits, but a late ack revives it, so the step keeps
    // waiting until its own deadline: the step's `timeout:` (or the flow timeout) is what counts.
    if (c && c.status !== 'pending' && c.status !== 'timeout') {
      throw new StateStepError('STATE_CMD_FAILED', `${step.op}: ${c.error || c.status} (ack phase reached: ${c.phase || 'none'}, wanted ${ack})`);
    }
    const ab = aborted(ctx);
    if (ab) throw ab;
    if (Date.now() >= deadline) {
      throw new StateStepError('STATE_ACK_TIMEOUT', `${step.op}: no ${ack} ack within ${limit / 1000}s (ack phase reached: ${(c && c.phase) || 'none'})`);
    }
    await sleep(POLL_MS);
  }
}

function brief(v) {
  const s = JSON.stringify(v);
  return s === undefined ? 'undefined' : s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

// Execute one state step. Returns { detail }; throws StateStepError (or the abort error).
async function execStep(step, ctx) {
  const st = ctx.state;
  if (!st) throw new StateStepError('STATE_NO_HUB', `${step.op}: state steps need the instrument hub and an instrumented build; no hub is running for this flow`);
  if (step.op === 'waitForAgent') {
    const limit = step.timeout !== undefined ? step.timeout * 1000 : ctx.stepTimeoutMs;
    const deadline = Date.now() + limit;
    while (!helloSeen(st)) {
      const ab = aborted(ctx);
      if (ab) throw ab;
      if (Date.now() >= deadline) throw new StateStepError('STATE_NOT_INSTRUMENTED', `waitForAgent: ${NOT_INSTRUMENTED} (waited ${limit / 1000}s)`);
      await sleep(POLL_MS);
    }
    st.handshook = true;
    return { detail: 'agent connected' };
  }
  if (!helloSeen(st)) throw new StateStepError('STATE_NOT_INSTRUMENTED', `${step.op}: ${NOT_INSTRUMENTED}`);
  const key = (name) => `${st.scope}:${name}`;
  switch (step.op) {
    case 'setState': {
      const cmd = setStateCommand(step);
      const c = await send(step, ctx, cmd.op, cmd.args);
      const what = step.ops ? `${step.ops.length} ops` : `${step.layer}.${step.path}`;
      return { detail: `${what} (${c.phase})` };
    }
    case 'snapshot': {
      const c = await send(step, ctx, 'snapshot', step.nodes ? { name: step.name, nodes: step.nodes } : { name: step.name });
      const layers = c.result && c.result.layers;
      if (!layers || typeof layers !== 'object') throw new StateStepError('STATE_CMD_FAILED', 'snapshot: the agent returned no layers');
      try { st.hub.stateOps.saveSnapshot(key(step.name), layers, Date.now()); st.snapshots.add(key(step.name)); } catch (e) {
        const full = e && e.code === 'STORE_FULL';
        throw new StateStepError('STATE_CMD_FAILED', `snapshot: ${e.message}${full ? '; the hub keeps at most 20 snapshots per run and drops a flow\'s snapshots when it ends, so reuse snapshot names or split the run' : ''}`);
      }
      return { detail: `${step.name} (${Object.keys(layers).length} layers)` };
    }
    case 'restore': {
      const layers = st.hub.stateOps.getSnapshot(key(step.name));
      if (!layers) throw new StateStepError('STATE_SNAPSHOT_NOT_FOUND', `restore: no snapshot named "${step.name}" in this flow (take it first with snapshot: ${step.name})`);
      const c = await send(step, ctx, 'restore', { name: step.name, layers });
      const skipped = c.result && Array.isArray(c.result.skipped) ? c.result.skipped.length : 0;
      return { detail: `${step.name} (${c.phase}${skipped ? `, ${skipped} skipped` : ''})` };
    }
    case 'callFunc': {
      const c = await send(step, ctx, 'callFunc', { node: step.node, fn: step.fn, args: step.args });
      const value = c.result && 'value' in c.result ? ` -> ${brief(c.result.value)}` : '';
      return { detail: `${step.node.id}.${step.fn}${value}` };
    }
    default:
      throw new StateStepError('STATE_BAD_COMMAND', `unknown state step ${step.op}`);
  }
}

// assertState { layer: node|m, node: { id }, path }: poll the hub `get` op until the value passes or the step times out.
// A masked value (the agent's `<redacted:key>` placeholder) cannot be compared, so equals/contains/deepEquals fail on it
// with a message that does not print the value; exists still works. Returns { detail }.
async function assertNode(step, ctx) {
  const st = ctx.state;
  if (!st) throw new StateStepError('STATE_NO_HUB', 'assertState: layer ' + step.layer + ' reads the node through the instrument hub and an instrumented build; no hub is running for this flow');
  if (!helloSeen(st)) throw new StateStepError('STATE_NOT_INSTRUMENTED', `assertState: ${NOT_INSTRUMENTED}`);
  const mode = step.deepEquals !== undefined ? 'deepEquals' : step.exists !== undefined ? 'exists' : step.equals !== undefined ? 'equals' : 'contains';
  const want = mode === 'equals' ? String(step.equals) : mode === 'contains' ? String(step.contains) : mode === 'deepEquals' ? step.deepEquals : step.exists;
  const limit = step.timeout !== undefined ? step.timeout * 1000 : ctx.stepTimeoutMs;
  const deadline = Date.now() + limit;
  const where = `${step.layer}:${step.node.id}.${step.path}`;
  const masked = (v) => /<redacted:[^>]*>/.test(JSON.stringify(v === undefined ? null : v));
  const test = (v) => {
    if (mode === 'exists') return (v !== undefined) === want;
    if (v === undefined || masked(v)) return false;
    if (mode === 'deepEquals') return deepEqual(v, want);
    return mode === 'equals' ? String(v) === want : String(v).includes(want);
  };
  const redactOn = appstate.redactStateOn(ctx);
  const showVal = appstate.makeShown(redactOn, appstate.stateMasks(ctx.cfg));
  const shownWant = mode === 'exists' ? JSON.stringify(want) : showVal(step.layer, step.path, want);
  let lastDesc = 'no read completed';
  for (;;) {
    const ab = aborted(ctx);
    if (ab) throw ab;
    let v, found = false;
    try {
      const c = await send({ ...step, timeout: Math.max(0.05, (deadline - Date.now()) / 1000) }, ctx, 'get', { layer: step.layer, node: step.node, path: step.path });
      const r = c.result && typeof c.result === 'object' ? c.result : {};
      found = r.found === true;
      v = found ? (r.value === undefined ? null : r.value) : undefined;
    } catch (e) {
      const m = e && /^[^:]*: ([A-Z][A-Z0-9_]*): /.exec(e.message || '');
      const code = m && m[1];
      // The path or field is not there (yet): an absent value, which exists: false accepts.
      if (code === 'FIELD_NOT_FOUND' || code === 'NODE_NOT_FOUND') { v = undefined; lastDesc = code === 'NODE_NOT_FOUND' ? `node "${step.node.id}" not found` : `path "${step.path}" not found`; }
      else if (e instanceof StateStepError && e.code === 'STATE_ACK_TIMEOUT' && Date.now() >= deadline) throw new StateStepError('STATE_ACK_TIMEOUT', `assertState ${where}: no answer from the app within ${limit / 1000}s`);
      else throw e;
    }
    if (found) lastDesc = masked(v) ? 'value is masked by the agent (redact paths or a secret-looking key), so it cannot be compared; use exists:' : `got ${showVal(step.layer, step.path, v)}`;
    else if (v === undefined && lastDesc === 'no read completed') lastDesc = `path "${step.path}" not found`;
    if (test(v)) {
      const sym = mode === 'equals' ? '= ' : mode === 'contains' ? '⊇ ' : mode === 'deepEquals' ? '≡ ' : 'exists ';
      return { detail: `${where} ${sym}${shownWant}` };
    }
    if (Date.now() >= deadline) throw new StateStepError('STATE_ASSERT_FAILED', `assertState ${where} ${mode} ${shownWant} — ${lastDesc}`);
    await sleep(POLL_MS);
  }
}

module.exports = { assertNode, isNodeAssert, STATE_OPS, setStateCommand, StateStepError, validateConfig, normalizeStep, usesState, planSession, beginFlow, awaitHandshake, execStep, endFlow };
