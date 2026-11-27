// @ts-check
'use strict';
const fs = require('fs');
const path = require('path');
const { compileMasks, maskMatches } = require('./mask-path');

// Event + command schema, validation, redaction, NDJSON writer and ring buffer for the instrument hub
// (design: app-state-devtools.md 4.4-4.5, 4.8). Node core only.

const RING_MAX = 2000;
const SRC = ['agent', 'hub', 'runner'];
// Allowed command ops (design D8). Anything else is refused host-side; the agent also refuses it.
const ALLOWED_OPS = [
  'ping', 'get', 'set', 'merge', 'snapshot', 'restore',
  'registry.read', 'registry.write', 'callFunc', 'dispatch', 'focus', 'subscribe',
];
const SENSITIVE_KEY = /token|secret|password|session|auth|cookie/i;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function placeholder(key) { return `<redacted:${key}>`; }

// Deep-copy `value` with sensitive keys (built-in key regex, plus dotted `paths` masks) replaced by
// "<redacted:key>". Mask syntax is in mask-path.js (`[n]` = `.n`, `*` matches one segment, case-insensitive). Masks
// are matched against the path inside `data`, and also with a leading "layers." removed so "global.user.token"
// masks data.layers.global.user.token. Array elements can be masked and show as "<redacted:index>". Deterministic.
/** @param {unknown} value @param {string[]} [paths] @param {unknown[]} [segs] @returns {any} */
function redact(value, paths = [], segs = []) {
  const masks = compileMasks(paths);
  return walk(value, masks, segs.map((x) => String(x).toLowerCase()));
}

function hidden(masks, l) {
  if (!masks.length) return false;
  const bare = l[0] === 'layers' ? l.slice(1) : null;
  for (const m of masks) if (maskMatches(m, l) || (bare && maskMatches(m, bare))) return true;
  return false;
}

function walk(value, masks, lsegs) {
  if (Array.isArray(value)) {
    return value.map((v, i) => {
      const k = String(i);
      const l = lsegs.concat(k);
      return hidden(masks, l) ? placeholder(k) : walk(v, masks, l);
    });
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const l = lsegs.concat(k.toLowerCase());
      out[k] = SENSITIVE_KEY.test(k) || hidden(masks, l) ? placeholder(k) : walk(v, masks, l);
    }
    return out;
  }
  return value;
}

// The envelope's own `session` field is not secret; only `data` is redacted.
function redactEvent(ev, paths = []) {
  const out = { ...ev };
  if ('data' in out) out.data = redact(out.data, paths);
  return out;
}

/** @param {any} ev untrusted input @returns {string | null} */
function validateEvent(ev) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return 'event must be an object';
  if (typeof ev.kind !== 'string' || !ev.kind) return 'event.kind must be a non-empty string';
  if (ev.v !== undefined && ev.v !== 1) return 'unsupported event version';
  if (ev.src !== undefined && !SRC.includes(ev.src)) return 'event.src must be agent, hub or runner';
  if (ev.data !== undefined && (ev.data === null || typeof ev.data !== 'object' || Array.isArray(ev.data))) return 'event.data must be an object';
  return null;
}

/** @param {any} cmd untrusted input @returns {string | null} */
function validateCommand(cmd) {
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) return 'command must be an object';
  if (!ALLOWED_OPS.includes(cmd.op)) return `op not allowed: ${String(cmd.op)}`;
  if (cmd.args !== undefined && (cmd.args === null || typeof cmd.args !== 'object' || Array.isArray(cmd.args))) return 'command.args must be an object';
  return null;
}

// Ring buffer of the last `max` events plus an NDJSON file under <sessionDir>/<sessionId>/events.ndjson
// (redacted before write). Events get a monotonic `seq` and a `ts` when they lack one.
/** @param {import('../../types/hub-events').EventLogOptions} [opts] @returns {import('../../types/hub-events').EventLog} */
function createEventLog({ sessionId, sessionDir = null, max = RING_MAX, redactPaths = [] } = {}) {
  if (!SAFE_ID.test(String(sessionId || ''))) throw new Error('createEventLog: sessionId must match [A-Za-z0-9_-]+');
  let seq = 0;
  /** @type {import('../../types/hub-events').HubEvent[]} */
  const ring = [];
  /** @type {string | null} */
  let file = null;
  if (sessionDir) {
    const dir = path.join(sessionDir, String(sessionId));
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'events.ndjson');
  }
  return {
    file,
    push(ev) {
      const stored = { v: /** @type {1} */ (1), ...ev, seq: ++seq, ts: ev.ts || Date.now(), session: /** @type {string} */ (sessionId) };
      ring.push(stored);
      if (ring.length > max) ring.splice(0, ring.length - max);
      if (file) fs.appendFileSync(file, JSON.stringify(redactEvent(stored, redactPaths)) + '\n');
      return stored;
    },
    // Events with seq > after (all retained events by default).
    since(after = 0) { return ring.filter((e) => e.seq > after); },
    get size() { return ring.length; },
    get lastSeq() { return seq; },
  };
}

module.exports = { RING_MAX, ALLOWED_OPS, redact, redactEvent, validateEvent, validateCommand, createEventLog };
