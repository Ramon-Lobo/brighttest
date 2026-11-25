'use strict';
const { ALLOWED_OPS, redact } = require('./events');
const { compileMasks, relativeToLayer } = require('./mask-path');

// Host-side state-write state machine (STA-S-T5; design app-state-devtools.md D6, 4.4, 4.5). Pure: no I/O, no timers, no
// clock of its own (callers pass `now`). The hub feeds it commands it queued and `cmd.ack` events it received.
//
// Ack phases are ordered received < applied < reflected. A command is complete when it reaches the phase it asked for
// (`applied` by default), or when `applied` comes back `ok:false`. Acks for a session other than the current one answer
// `resync`; `resync(session)` abandons every open command (it never resends one).

const MAX_STATE_BYTES = 65536; // same default cap as the agent serializer (STA-S-T1 publish.maxBytes)
const PHASES = ['received', 'applied', 'reflected'];
const DEFAULT_TIMEOUTS = { received: 5000, applied: 10000, reflected: 15000 }; // ms, from queue time per phase
const MAX_TRACKED = 500;
const MAX_SNAPSHOTS = 20;

class StateOpsError extends Error {
  constructor(code, message) { super(message); this.name = 'StateOpsError'; this.code = code; }
}

function byteLen(v) { return Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v), 'utf8'); }

// Throws STATE_TOO_LARGE for anything over `maxBytes`. Never truncates.
function checkSize(value, maxBytes = MAX_STATE_BYTES) {
  const n = byteLen(value);
  if (n > maxBytes) throw new StateOpsError('STATE_TOO_LARGE', `state payload is ${n} bytes, over the ${maxBytes}-byte limit; send less, nothing is truncated`);
  return n;
}

// ---- layer-scoped diff ----------------------------------------------------------------------------------------------

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function diffInto(ops, layer, segs, a, b) {
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(a).sort()) if (!(k in b)) ops.push({ op: 'del', layer, path: segs.concat(k).join('.') });
    for (const k of Object.keys(b).sort()) {
      if (!(k in a)) ops.push({ op: 'set', layer, path: segs.concat(k).join('.'), value: b[k] });
      else diffInto(ops, layer, segs.concat(k), a[k], b[k]);
    }
    return;
  }
  if (!same(a, b)) ops.push({ op: 'set', layer, path: segs.join('.'), value: b });
}

// Diff two `layers` maps ({global:{…}, registry:{…}}) into [{op:'set'|'del', layer, path, value?}], sorted by layer; within an
// object, deletes come first, then sets by key. `layers` limits it to those layers. Arrays and scalars are leaves.
function diffLayers(before, after, { layers = null } = {}) {
  const a = before || {}, b = after || {};
  const names = (layers || [...new Set([...Object.keys(a), ...Object.keys(b)])]).slice().sort();
  const ops = [];
  for (const layer of names) {
    if (!(layer in b)) { if (layer in a) ops.push({ op: 'del', layer, path: '' }); continue; }
    if (!(layer in a)) { ops.push({ op: 'set', layer, path: '', value: b[layer] }); continue; }
    diffInto(ops, layer, [], a[layer], b[layer]);
  }
  return ops;
}

// A copy of a command safe to persist: `set`/`merge`/`registry.write` values (including each value inside an `ops` batch)
// under a sensitive path segment or a configured redact mask become "<redacted:key>"; `callFunc` args are scrubbed by key.
function redactedValue(layer, pathStr, value, redactPaths) {
  const segs = pathStr.split('.');
  const nested = segs.reduceRight((acc, s) => ({ [s]: acc }), value);
  const masks = relativeToLayer(compileMasks(redactPaths), layer).map((m) => m.join('.'));
  let cur = redact(nested, masks);
  for (const s of segs) { if (!cur || typeof cur !== 'object') break; cur = cur[s]; }
  return cur;
}
function loggable(cmd, redactPaths = []) {
  const args = cmd.args && typeof cmd.args === 'object' ? { ...cmd.args } : {};
  if ('value' in args && typeof args.path === 'string' && args.path) {
    args.value = redactedValue(args.layer, args.path, args.value, redactPaths);
  } else if ('value' in args) {
    args.value = redact({ value: args.value }, redactPaths).value;
  }
  if (Array.isArray(args.ops)) {
    args.ops = args.ops.map((o) => (o && typeof o === 'object' && typeof o.path === 'string' && o.path && 'value' in o
      ? { ...o, value: redactedValue(args.layer, o.path, o.value, redactPaths) } : o));
  }
  if (cmd.op === 'registry.write' && 'value' in args && typeof args.section === 'string' && typeof args.key === 'string') {
    args.value = redactedValue('registry', `${args.section}.${args.key}`, args.value, redactPaths);
  }
  if (args.layers && typeof args.layers === 'object') args.layers = redact({ layers: args.layers }, redactPaths).layers;
  if (cmd.op === 'callFunc' && Array.isArray(args.args)) args.args = redact({ args: args.args }, redactPaths).args;
  return { id: cmd.id, seq: cmd.seq, op: cmd.op, args };
}

// ---- the machine ----------------------------------------------------------------------------------------------------

function createStateOps({ session, timeouts = {}, maxBytes = MAX_STATE_BYTES, maxTracked = MAX_TRACKED } = {}) {
  if (!session) throw new StateOpsError('USAGE', 'createStateOps: session is required');
  let cur = session;
  const limits = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const cmds = new Map(); // id -> record (insertion order = seq order)
  const store = new Map(); // snapshot name -> { layers, at }
  let highApplied = 0;
  const gaps = new Set(); // seqs whose applied ack arrived after a higher seq was already applied
  const counters = { duplicates: 0, unknown: 0, stale: 0, outOfOrder: 0 };

  function view(r) {
    return { id: r.id, seq: r.seq, op: r.op, want: r.want, phase: r.phase, status: r.status, ok: r.ok, error: r.error, result: r.result, hash: r.hash };
  }
  function trim() {
    while (cmds.size > maxTracked) {
      const first = cmds.keys().next().value;
      const r = cmds.get(first);
      if (r.status === 'pending') break; // never drop an open command
      cmds.delete(first);
    }
  }

  return {
    get session() { return cur; },
    get counters() { return { ...counters }; },
    get limits() { return { ...limits }; },

    // Validate a request body into a command draft: { op, args, ack }. Sizes are checked on the serialized args.
    prepare(body) {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StateOpsError('BAD_COMMAND', 'state request must be a JSON object');
      if (!ALLOWED_OPS.includes(body.op)) throw new StateOpsError('BAD_COMMAND', `op not allowed: ${String(body.op)}`);
      if (body.args !== undefined && !isObj(body.args)) throw new StateOpsError('BAD_COMMAND', 'args must be an object');
      const ack = body.ack === undefined ? 'applied' : body.ack;
      if (ack !== 'applied' && ack !== 'reflected') throw new StateOpsError('BAD_COMMAND', 'ack must be applied or reflected');
      checkSize(body.args || {}, maxBytes);
      return { op: body.op, args: body.args || {}, ack };
    },

    // Track a command the hub queued (`full` has id, seq, session). Seqs must strictly increase.
    track(full, { ack = 'applied', now = 0 } = {}) {
      if (!full || !full.id || !Number.isInteger(full.seq)) throw new StateOpsError('BAD_COMMAND', 'track needs a command with id and seq');
      if (cmds.has(full.id)) throw new StateOpsError('BAD_COMMAND', `command ${full.id} is already tracked`);
      const last = [...cmds.values()].pop();
      if (last && full.seq <= last.seq) throw new StateOpsError('BAD_COMMAND', `seq ${full.seq} does not follow ${last.seq}`);
      const r = { id: full.id, seq: full.seq, op: full.op, want: ack, phase: null, status: 'pending', ok: null, queuedAt: now, error: null, result: undefined, hash: undefined };
      cmds.set(full.id, r);
      trim();
      return view(r);
    },

    // Apply an agent `cmd.ack` ({id, seq, phase, ok, result?, error?, hash?, session?}). Returns { kind, cmd? } where
    // kind is one of applied-update | duplicate | unknown | resync | invalid.
    onAck(ack) {
      if (!ack || typeof ack !== 'object' || !PHASES.includes(ack.phase)) return { kind: 'invalid' };
      if (ack.session && ack.session !== cur) { counters.stale++; return { kind: 'resync', session: cur }; }
      const r = cmds.get(ack.id);
      if (!r || (ack.seq !== undefined && ack.seq !== r.seq)) { counters.unknown++; return { kind: 'unknown' }; }
      const rank = PHASES.indexOf(ack.phase);
      if (r.phase !== null && rank <= PHASES.indexOf(r.phase)) { counters.duplicates++; return { kind: 'duplicate', cmd: view(r) }; }
      if (r.status !== 'pending' && r.status !== 'timeout') { counters.duplicates++; return { kind: 'duplicate', cmd: view(r) }; }
      if (ack.phase === 'applied') {
        if (r.seq < highApplied) { gaps.add(r.seq); counters.outOfOrder++; }
        else highApplied = r.seq;
      }
      if (r.status === 'timeout') { r.ok = null; r.error = null; } // a late ack revives a timed-out command
      r.phase = ack.phase;
      if (ack.ok === false || ack.error) { r.ok = false; r.error = ack.error || 'failed'; }
      if (ack.result !== undefined) r.result = ack.result;
      if (ack.hash !== undefined) r.hash = ack.hash;
      if (ack.phase !== 'received' && r.ok === null) r.ok = true;
      if (r.ok === false && ack.phase !== 'received') r.status = 'failed';
      else if (rank >= PHASES.indexOf(r.want)) r.status = 'done';
      else r.status = 'pending';
      return { kind: 'applied-update', cmd: view(r) };
    },

    // Time out open commands. A command waits for `received` first, then for the phase it still needs, each limit
    // counted from queue time. Returns the commands that just timed out (each at most once).
    tick(now) {
      const out = [];
      for (const r of cmds.values()) {
        if (r.status !== 'pending') continue;
        const waiting = r.phase === null ? 'received' : PHASES[PHASES.indexOf(r.phase) + 1];
        const limit = waiting === 'received' ? limits.received : waiting === 'applied' ? limits.applied : limits.reflected;
        if (now - r.queuedAt >= limit) {
          r.status = 'timeout';
          r.ok = false;
          r.error = `timeout waiting for ${waiting} ack after ${limit} ms`;
          out.push(view(r));
        }
      }
      return out;
    },

    // The session changed (the hub answered 409 {resync}, or a new lease holder). Every open command is abandoned with
    // an error and never resent; later acks for it answer `unknown`. Returns the abandoned commands.
    resync(newSession) {
      const out = [];
      for (const r of cmds.values()) {
        if (r.status !== 'pending' && r.status !== 'timeout') continue;
        r.status = 'abandoned';
        r.ok = false;
        r.error = 'session changed (resync); command was not replayed';
        out.push(view(r));
      }
      if (newSession) cur = newSession;
      return out;
    },

    // Drop a finished record (an internal read whose result was consumed). A still-open command is kept.
    forget(id) { const r = cmds.get(id); if (r && r.status !== 'pending') cmds.delete(id); },
    get(id) { const r = cmds.get(id); return r ? view(r) : null; },
    list() { return [...cmds.values()].map(view); },
    get pending() { return [...cmds.values()].filter((r) => r.status === 'pending').length; },
    // Seqs that were applied out of order (the agent must apply in seq order).
    get gaps() { return [...gaps].sort((x, y) => x - y); },
    // Open commands with a seq below the highest applied one: a missing ack in the sequence.
    missing() { return [...cmds.values()].filter((r) => r.status === 'pending' && r.seq < highApplied).map((r) => r.seq); },

    // Snapshot store: named, bounded, in memory. Too-large snapshots are refused.
    saveSnapshot(name, layers, now = 0) {
      if (!name || typeof name !== 'string') throw new StateOpsError('BAD_COMMAND', 'snapshot name must be a non-empty string');
      checkSize(layers, maxBytes);
      if (!store.has(name) && store.size >= MAX_SNAPSHOTS) throw new StateOpsError('STORE_FULL', `snapshot store is full (${MAX_SNAPSHOTS}); delete one first`);
      store.set(name, { layers: JSON.parse(JSON.stringify(layers)), at: now });
      return { name, at: now };
    },
    getSnapshot(name) { const s = store.get(name); return s ? JSON.parse(JSON.stringify(s.layers)) : null; },
    listSnapshots() { return [...store.entries()].map(([name, s]) => ({ name, at: s.at })); },
    deleteSnapshot(name) { return store.delete(name); },
    diffSnapshots(a, b, opts) {
      const x = store.get(a), y = store.get(b);
      if (!x || !y) throw new StateOpsError('NOT_FOUND', `snapshot not found: ${!x ? a : b}`);
      return diffLayers(x.layers, y.layers, opts);
    },
  };
}

module.exports = { MAX_STATE_BYTES, PHASES, DEFAULT_TIMEOUTS, StateOpsError, createStateOps, checkSize, diffLayers, loggable };
