'use strict';
const fs = require('fs');
const path = require('path');

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

function pathMatches(pattern, segs) {
  // `a.list[1]` is the same as `a.list.1`; segments compare ignoring case.
  const p = String(pattern).replace(/\[(\d+)\]/g, '.$1').replace(/^\./, '').split('.');
  if (p.length !== segs.length) return false;
  return p.every((part, i) => part === '*' || part.toLowerCase() === String(segs[i]).toLowerCase());
}

// Deep-copy `value` with sensitive keys (built-in key regex, plus dotted `paths` masks where `*` matches one
// segment) replaced by "<redacted:key>". Masks are matched against the path inside `data`, and also with a
// leading "layers." removed so "global.user.token" masks data.layers.global.user.token. Deterministic.
function redact(value, paths = [], segs = []) {
  if (Array.isArray(value)) {
    return value.map((v, i) => {
      const here = segs.concat(String(i));
      const bare = here[0] === 'layers' ? here.slice(1) : here;
      const masked = paths.some((p) => pathMatches(p, here) || (bare !== here && pathMatches(p, bare)));
      return masked ? placeholder(String(i)) : redact(v, paths, here);
    });
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const here = segs.concat(k);
      const bare = here[0] === 'layers' ? here.slice(1) : here;
      const masked = SENSITIVE_KEY.test(k) || paths.some((p) => pathMatches(p, here) || (bare !== here && pathMatches(p, bare)));
      out[k] = masked ? placeholder(k) : redact(v, paths, here);
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

function validateEvent(ev) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return 'event must be an object';
  if (typeof ev.kind !== 'string' || !ev.kind) return 'event.kind must be a non-empty string';
  if (ev.v !== undefined && ev.v !== 1) return 'unsupported event version';
  if (ev.src !== undefined && !SRC.includes(ev.src)) return 'event.src must be agent, hub or runner';
  if (ev.data !== undefined && (ev.data === null || typeof ev.data !== 'object' || Array.isArray(ev.data))) return 'event.data must be an object';
  return null;
}

function validateCommand(cmd) {
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) return 'command must be an object';
  if (!ALLOWED_OPS.includes(cmd.op)) return `op not allowed: ${String(cmd.op)}`;
  if (cmd.args !== undefined && (cmd.args === null || typeof cmd.args !== 'object' || Array.isArray(cmd.args))) return 'command.args must be an object';
  return null;
}

// Ring buffer of the last `max` events plus an NDJSON file under <sessionDir>/<sessionId>/events.ndjson
// (redacted before write). Events get a monotonic `seq` and a `ts` when they lack one.
function createEventLog({ sessionId, sessionDir = null, max = RING_MAX, redactPaths = [] } = {}) {
  if (!SAFE_ID.test(String(sessionId || ''))) throw new Error('createEventLog: sessionId must match [A-Za-z0-9_-]+');
  let seq = 0;
  const ring = [];
  let file = null;
  if (sessionDir) {
    const dir = path.join(sessionDir, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'events.ndjson');
  }
  return {
    file,
    push(ev) {
      const stored = { v: 1, ...ev, seq: ++seq, ts: ev.ts || Date.now(), session: sessionId };
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
