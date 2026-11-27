// @ts-check
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const { spawnSync } = require('child_process');

// Cross-process device lease: one holder per Roku at a time, FIFO waiters, crash-safe. Lock files in a
// per-user dir (default ~/.brighttest/leases, override BRIGHTTEST_LEASE_DIR); Node core only.
//
//   <dir>/<key>/holder.json    present while held (created with link(), so readers never see a partial file)
//   <dir>/<key>/queue/*.json   FIFO tickets (<15-digit ms>-<leaseId>.json); only the head may acquire
//   <dir>/<key>/reclaim.lock/  mkdir mutex: every delete of holder.json happens under it
//   <dir>/<key>/events.log     JSONL audit (rotated at 1 MB to events.log.1)
//   <dir>/<key>/tombstones/<leaseId>  written under the mutex by every reclaim and force-unlock: the victim
//                              holder sees it and goes LOST instead of re-creating holder.json
//   <dir>/<key>/dir.id         random id of this lease directory: a holder re-asserts a missing holder.json
//                              only when the id changed (the directory itself was deleted)
//
// Liveness is the holder PID (plus start time, plus registered child process groups), bounded by a hard
// deadline. The heartbeat detects a lost lease (and re-creates holder.json only after the whole lease
// directory was deleted); it is not a liveness test (laptop sleep would make every healthy holder look dead).

const SCHEMA = 'brighttest-lease/v1';
const DEFAULT_ECP_PORT = 8060;
const DEFAULTS = require('./config').DEVICE_LEASE_DEFAULTS; // brighttest.json `deviceLease` defaults
const { sanitize } = require('./tui'); // strips control bytes from holder text before it is printed
const POLL_MS = 1000;
const POLL_JITTER_MS = 250;
const HEARTBEAT_MS = 15000;
const WAIT_LINE_MS = 30000;
const EXPIRE_MARGIN_MS = 5000;
const CORRUPT_GRACE_MS = 5000;
const RECLAIM_LOCK_STALE_MS = 30000;
// How long a waiter whose process died (SIGKILL, e.g. a Bash tool timeout) keeps its place in the queue: a
// restarted waiter with the same agent and purpose adopts the ticket within this window (F12, D9).
const TICKET_GRACE_MS = 60000;
const ETA_SAMPLE = 10; // median over the last N `released` events with the same command verb
const SETTLE_MS = 25;
const TOMBSTONE_TTL_MS = 24 * 3600 * 1000;
const MAX_TIMER_MS = 2 ** 31 - 1; // setTimeout overflows (and fires at once) beyond this, ~24.8 days
const EVENTS_MAX_BYTES = 1024 * 1024;

class LeaseError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'LeaseError';
    this.code = code; // BUSY | TIMEOUT | LEASE_LOST | IO | CANCELLED | USAGE
    Object.assign(this, extra);
  }
}

const LEASE_EXIT = { busy: 75, lost: 77, dir: 78 };

// Exit codes: 75 busy / wait timed out, 77 lease lost / expired / not held, 78 lease dir unusable.
function exitCodeFor(err) {
  if (!err) return 0;
  switch (err.code) {
    case 'BUSY': case 'TIMEOUT': return LEASE_EXIT.busy;
    case 'LEASE_LOST': case 'NOT_HELD': return LEASE_EXIT.lost;
    case 'IO': return LEASE_EXIT.dir;
    case 'CANCELLED': return 130;
    case 'USAGE': return 2;
    default: return 1;
  }
}

// ---- durations --------------------------------------------------------------------------------
// "90s", "10m", "1h", "250ms" or plain milliseconds. 0 means "do not wait".
function parseDuration(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.round(v);
  const s = String(v == null ? '' : v).trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(s);
  if (!m) throw new LeaseError('USAGE', `invalid duration "${v}" (use e.g. 90s, 10m, 1h or milliseconds)`);
  const n = Number(m[1]);
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2] || 'ms'];
  return Math.round(n * mult);
}

// A hold cap must fit a timer: the self-expiry is a setTimeout.
function checkMaxHold(ms) {
  if (ms > MAX_TIMER_MS) {
    throw new LeaseError('USAGE', `invalid --max / maxHold: ${formatDuration(ms)} is too long (the limit is ${MAX_TIMER_MS} ms, about 24.8 days; use e.g. 60m)`);
  }
  return ms;
}

function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '?';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

// ---- redaction --------------------------------------------------------------------------------
// Keep only the program name of a `-- <cmd>` child. Drop `--password <x>`, `--password=…` (and --pass), and the `:pw` part of `--host ip:pw[,ip:pw]`.
// Any literal secret passed in `secrets` is masked wherever it appears.
function redactArgv(argv, secrets = []) {
  const out = [];
  const list = Array.isArray(argv) ? argv.map(String) : String(argv || '').split(/\s+/).filter(Boolean);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    // Everything after a bare `--` is a child command (`device with -- <cmd> …`): its arguments can carry
    // secrets in any form, so only the program name is kept.
    if (a === '--') { out.push('--'); if (i + 1 < list.length) out.push(path.basename(list[i + 1]), '…'); break; }
    if (a === '--password' || a === '--pass') { out.push(a, '***'); i++; continue; }
    if (/^--pass(word)?=/.test(a)) { out.push(a.replace(/=.*$/, '=***')); continue; }
    if (a === '--host' && i + 1 < list.length) { out.push(a, stripHostPasswords(list[++i])); continue; }
    if (a.startsWith('--host=')) { out.push('--host=' + stripHostPasswords(a.slice(7))); continue; }
    out.push(a);
  }
  return redactText(out.join(' '), secrets);
}
function stripHostPasswords(v) {
  return String(v).split(',').map((h) => {
    const t = h.trim();
    // ip:pw — an IPv4/hostname followed by one colon. Bare IPv6 (several colons) is left alone.
    const idx = t.indexOf(':');
    if (idx > 0 && t.indexOf(':', idx + 1) === -1) return t.slice(0, idx);
    return t;
  }).join(',');
}
function redactText(text, secrets = []) {
  let s = String(text == null ? '' : text);
  for (const sec of secrets) if (sec && String(sec).length >= 3) s = s.split(String(sec)).join('***');
  return s;
}
function hashSerial(serial) {
  return serial ? crypto.createHash('sha256').update(String(serial)).digest('hex').slice(0, 12) : null;
}

// ---- keys -------------------------------------------------------------------------------------
// The key is the host resolved to an IP (so `roku.local` and its address share a key), lowercased,
// with `:` → `_` for IPv6, plus `_p<port>` when the ECP port is not the default 8060 (local fakes).
// When the device identity (serial or device-id, as reported by the device-info path) is already known the
// key is `id-<hash of identity>` instead: one lease per device, whatever address or port reaches it, and two
// devices never share a lease. normalizeKey makes no device call, so callers that have not read the identity
// get the address key (the fallback below). Callers pass it as `deviceId` (acquire option / normalizeKey option).
// Known limit: the same device can get two keys, so two holders at once. (1) A hostname that does not
// resolve falls back to the literal name, while another process that resolves it (or uses the IP) keys by
// IP; `onFallback` is called so the caller can warn. (2) The ECP port is part of the key, so a lane run with
// a different ROKU_ECP_PORT than another lane keys the same box differently. Use the IP and the default port.
function keyFromAddress(addr, port) {
  let k = String(addr).trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/:/g, '_');
  k = k.replace(/[^a-z0-9._-]/g, '_');
  const p = port == null || port === '' ? DEFAULT_ECP_PORT : Number(port);
  if (p !== DEFAULT_ECP_PORT) k += `_p${p}`;
  return k;
}
const isIpLiteral = (h) => require('net').isIP(String(h).replace(/^\[|\]$/g, '')) !== 0;
function keyFromIdentity(identity) {
  return 'id-' + crypto.createHash('sha256').update(String(identity).trim()).digest('hex').slice(0, 16);
}
/** @param {string} host @param {{ port?: any, lookup?: any, onFallback?: any, deviceId?: any }} [o] */
async function normalizeKey(host, { port, lookup, onFallback, deviceId } = {}) {
  if (deviceId != null && String(deviceId).trim() !== '') return keyFromIdentity(deviceId);
  if (!host) throw new LeaseError('USAGE', 'no device host to lease (pass --host or set ROKU_HOST)');
  const h = stripHostPasswords(String(host).trim());
  let addr = h;
  try {
    const r = await (lookup || dns.promises.lookup)(h.replace(/^\[|\]$/g, ''));
    if (r && r.address) addr = r.address;
  } catch { /* unresolvable: fall back to the literal host */ }
  if (addr === h && !isIpLiteral(h) && onFallback) onFallback(h);
  return keyFromAddress(addr, port);
}

// ---- process facts ----------------------------------------------------------------------------
function isAlive(pid) {
  if (!pid || !Number.isInteger(Number(pid))) return false;
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
// Process start time: Linux /proc/<pid>/stat field 22, macOS/BSD `ps -o lstart=`; null elsewhere.
// `ps` prints lstart in the caller's TZ and locale, so it runs with LC_ALL=C and TZ=UTC: a holder and a
// waiter with different TZ/LANG must read the same string for the same live process. Lookups are cached
// for PS_CACHE_MS so a waiter polling every second does not spawn a `ps` per ticket per poll.
const PS_CACHE_MS = 2000;
const psCache = new Map();
function pidStart(pid, { fresh = false } = {}) {
  if (!pid) return null;
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return fields[19] || null; // field 22 overall; fields[0] is field 3
    }
    if (process.platform === 'win32') return null;
    const t = Date.now();
    const hit = psCache.get(pid);
    if (hit && !fresh && t - hit.t < PS_CACHE_MS) return hit.v;
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    });
    const v = (r.stdout || '').trim() || null;
    if (psCache.size > 256) psCache.clear();
    psCache.set(pid, { t, v });
    return v;
  } catch { return null; }
}
function clearPidStartCache() { psCache.clear(); }

// Git identity of the cwd, read once before acquiring (fail-soft to null).
function gitIdentity(cwd) {
  const git = (args) => {
    try {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
      return r.status === 0 ? (r.stdout || '').trim() || null : null;
    } catch { return null; }
  };
  return { worktree: git(['rev-parse', '--show-toplevel']), branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) };
}

// ---- sync sleep (release paths run inside exit handlers) --------------------------------------
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) { Atomics.wait(sleepBuf, 0, 0, ms); }
const HOLDER_RECHECK_TRIES = 5;
const HOLDER_RECHECK_MS = 100;
const HOLDER_RECHECK_DEADLINE_MS = 1000;
const sleepAsync = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the store --------------------------------------------------------------------------------
function defaultDir(env = process.env) {
  return env.BRIGHTTEST_LEASE_DIR || path.join(os.homedir(), '.brighttest', 'leases');
}

// ---- pure helpers (shared with the read-only lease monitor; no I/O except the injected liveness probes) -----
// 'dead' when the ticket's waitUntil has passed, or its PID is dead (or reused) and it has not been touched for
// graceMs; else 'live'. A dead ticket is swept by the next waiter; the monitor only reports it.
// ctx = { now (ms), hostname, alive(pid), startOf(pid, opts), graceMs }.
function ticketState(t, ctx = {}) {
  const n = ctx.now != null ? ctx.now : Date.now();
  const alive = ctx.alive || isAlive;
  const startOf = ctx.startOf || pidStart;
  const graceMs = ctx.graceMs != null ? ctx.graceMs : TICKET_GRACE_MS;
  if (t.waitUntil && n > Date.parse(t.waitUntil)) return 'dead';
  if (t.hostname && t.hostname !== (ctx.hostname || os.hostname())) return 'live';
  let dead = !alive(t.pid);
  if (!dead && t.pidStart) {
    let cur = startOf(t.pid);
    if (cur && cur !== t.pidStart) cur = startOf(t.pid, { fresh: true }); // no verdict from a cached mismatch
    if (cur && cur !== t.pidStart) dead = true;
  }
  return dead && n - t.mtimeMs > graceMs ? 'dead' : 'live';
}

// The command verb ("sideload", "run", "e2e", ...) groups past holds for the ETA. Events and holders written
// before the verb field existed (or by a caller that names none) group under "other".
function verbOf(x) { const v = x && x.verb; return typeof v === 'string' && v.trim() ? v.trim() : 'other'; }
function cleanVerb(v) { const w = String(v == null ? '' : v).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 24); return w || 'other'; }
// Median heldMs of the last ETA_SAMPLE `released` events with the same verb; null with none.
function medianHeldMs(events, verb) {
  const held = events.filter((e) => e.ev === 'released' && Number.isFinite(e.heldMs) && verbOf(e) === verb)
    .slice(-ETA_SAMPLE).map((e) => e.heldMs).sort((a, b) => a - b);
  if (!held.length) return null;
  const m = held.length >> 1;
  return held.length % 2 ? held[m] : Math.round((held[m - 1] + held[m]) / 2);
}
// Honest wording for an unknown ETA (null when the ETA is known). overdueMs: how far the holder is past its
// expected hold. Never a negative or invented estimate.
function etaNote(etaMs, overdueMs) {
  if (etaMs != null) return null;
  if (Number.isFinite(overdueMs) && overdueMs > 0) return `past expected hold by ${formatDuration(overdueMs)}; ETA unknown`;
  return 'ETA unknown (no --expect)';
}
// ETA (estimate only, never gates a lane): the holder's remaining time (its --expect, else the median of
// past holds) plus the expected hold of each ticket ahead. etaMs is the wait until the device is free for
// someone at the back; perTicket[i] is the wait until ticket i's turn. null = unknown. nowMs is the clock.
// An overdue holder (past its expected hold) has no known remaining time: overdueMs says by how much.
function computeEtaAt(holder, queue, events, nowMs) {
  /** @type {number | null} */
  let remaining = null; let overdueMs;
  if (holder && holder.acquiredAt) {
    const elapsed = nowMs - Date.parse(holder.acquiredAt);
    const ih = holder.holder;
    const act = isInteractive(ih) && !ih.busy && Number(ih.yieldAfterMs) >= 0 ? Date.parse(ih.activityAt) : NaN;
    if (Number.isFinite(act)) {
      // interactive holder (Studio; wins over the synthetic studio expectMs): it yields to waiters yieldAfterMs after its last action, so that is the basis
      remaining = Math.max(0, Number(ih.yieldAfterMs) - (nowMs - act));
    } else {
      const expect = holder.expectMs || medianHeldMs(events, verbOf(holder.holder));
      if (expect) {
        if (elapsed > expect) overdueMs = Math.round(elapsed - expect);
        else remaining = expect - elapsed;
      }
    }
  } else if (!holder) remaining = 0;
  /** @type {number | null} */
  let acc = remaining;
  const perTicket = queue.map((t) => {
    const mine = acc;
    const exp = medianHeldMs(events, verbOf(t));
    acc = acc == null || exp == null ? null : acc + exp;
    return mine;
  });
  return { etaMs: acc, perTicket, ...(overdueMs !== undefined ? { overdueMs } : {}) };
}

function createStore(o = {}) {
  const env = o.env || process.env;
  const io = o.fs || fs;
  const dir = path.resolve(o.dir || defaultDir(env));
  const now = o.now || (() => Date.now());
  const alive = o.isAlive || isAlive;
  const startOf = o.pidStart || pidStart;
  const hostname = o.hostname || os.hostname();
  const sleep = o.sleep || sleepAsync;
  const random = o.random || Math.random;

  const keyDir = (key) => path.join(dir, key);
  const holderPath = (key) => path.join(keyDir(key), 'holder.json');
  const queueDir = (key) => path.join(keyDir(key), 'queue');
  const mutexPath = (key) => path.join(keyDir(key), 'reclaim.lock');
  const eventsPath = (key) => path.join(keyDir(key), 'events.log');
  const tombDir = (key) => path.join(keyDir(key), 'tombstones');
  const dirIdPath = (key) => path.join(keyDir(key), 'dir.id');

  function ioError(e, where) {
    if (e instanceof LeaseError) return e;
    const p = e && e.path ? e.path : where;
    return new LeaseError('IO',
      `lease dir is not usable: ${p} (${e && e.code ? e.code : e && e.message}). ` +
      'Fix its permissions or free disk space, or point BRIGHTTEST_LEASE_DIR at a writable local directory.',
      { path: p, cause: e });
  }

  function ensureKeyDir(key) {
    try {
      io.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const st = io.statSync(dir);
      if (!st.isDirectory()) { const e = Object.assign(new Error('not a directory'), { code: 'ENOTDIR', path: dir }); throw e; }
      io.mkdirSync(queueDir(key), { recursive: true, mode: 0o700 });
      io.accessSync(keyDir(key), fs.constants.W_OK);
      io.accessSync(queueDir(key), fs.constants.W_OK);
      if (!readDirId(key)) createExclusive(dirIdPath(key), crypto.randomBytes(8).toString('hex'));
    } catch (e) { throw ioError(e, dir); }
  }
  function readDirId(key) {
    try { return String(io.readFileSync(dirIdPath(key), 'utf8')).trim() || null; } catch { return null; }
  }

  // Tombstones (B2): a revoked lease id. Written under the reclaim mutex, before holder.json is unlinked.
  function writeTombstone(key, leaseId, info = {}) {
    if (!leaseId) return;
    try {
      io.mkdirSync(tombDir(key), { recursive: true, mode: 0o700 });
      io.writeFileSync(path.join(tombDir(key), leaseId), JSON.stringify({ at: new Date(now()).toISOString(), ...info }), { mode: 0o600 });
      for (const n of io.readdirSync(tombDir(key))) { // old tombstones are useless: their holder is long gone
        try { if (now() - io.statSync(path.join(tombDir(key), n)).mtimeMs > TOMBSTONE_TTL_MS) io.unlinkSync(path.join(tombDir(key), n)); } catch { /* gone */ }
      }
    } catch (e) { throw ioError(e, tombDir(key)); }
  }
  function isTombstoned(key, leaseId) {
    try { io.statSync(path.join(tombDir(key), leaseId)); return true; } catch { return false; }
  }

  // Write content to a private tmp file next to `target` and return its path.
  function writeTmp(target, content) {
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const fd = io.openSync(tmp, 'wx', 0o600);
    try { io.writeSync(fd, content); try { io.fsyncSync(fd); } catch { /* best-effort */ } }
    finally { io.closeSync(fd); }
    return tmp;
  }
  // Create-if-absent: link(tmp, target) fails atomically with EEXIST and publishes a complete file.
  // Falls back to open(wx) + write + fsync where hard links are unsupported (exFAT …).
  function createExclusive(target, content) {
    const tmp = writeTmp(target, content);
    try {
      io.linkSync(tmp, target);
      return true;
    } catch (e) {
      if (e.code === 'EEXIST') return false;
      if (['EPERM', 'ENOTSUP', 'ENOSYS', 'EOPNOTSUPP', 'EXDEV'].includes(e.code)) {
        let fd;
        try { fd = io.openSync(target, 'wx', 0o600); } catch (e2) { if (e2.code === 'EEXIST') return false; throw e2; }
        try { io.writeSync(fd, content); try { io.fsyncSync(fd); } catch { /* best-effort */ } } finally { io.closeSync(fd); }
        return true;
      }
      throw e;
    } finally { try { io.unlinkSync(tmp); } catch { /* gone */ } }
  }
  // Replace in place (heartbeat, childPids): tmp + rename.
  function replaceFile(target, content) {
    const tmp = writeTmp(target, content);
    try { io.renameSync(tmp, target); } catch (e) { try { io.unlinkSync(tmp); } catch { /* gone */ } throw e; }
  }

  // Read holder.json → { lease } | { corrupt: true, ageMs } | null (free).
  /** @param {string} key @returns {import('../types/lease').HolderRead} */
  function readHolder(key) {
    let text, st;
    try { st = io.statSync(holderPath(key)); text = io.readFileSync(holderPath(key), 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return null; throw ioError(e, holderPath(key)); }
    try {
      const lease = JSON.parse(text);
      if (!lease || typeof lease !== 'object' || !lease.leaseId) throw new Error('bad lease');
      return { lease, mtimeMs: st.mtimeMs };
    } catch { return { corrupt: true, ageMs: now() - st.mtimeMs, mtimeMs: st.mtimeMs }; }
  }

  // ---- events ---------------------------------------------------------------------------------
  function logEvent(key, ev) {
    try {
      io.mkdirSync(keyDir(key), { recursive: true, mode: 0o700 });
      const p = eventsPath(key);
      try { if (io.statSync(p).size > EVENTS_MAX_BYTES) io.renameSync(p, p + '.1'); } catch { /* none yet */ }
      const rec = { t: new Date(now()).toISOString(), key, ...ev };
      io.appendFileSync(p, JSON.stringify(rec) + '\n', { mode: 0o600 });
    } catch { /* the audit log is best-effort */ }
  }
  /** @param {{ key?: string, tail?: number }} [o] @returns {import('../types/lease').LeaseEvent[]} */
  function readEvents({ key, tail } = {}) {
    const keys = key ? [key] : listKeys();
    /** @type {any[]} */
    let all = [];
    for (const k of keys) {
      for (const f of [eventsPath(k) + '.1', eventsPath(k)]) {
        let text = '';
        try { text = io.readFileSync(f, 'utf8'); } catch { continue; }
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try { all.push(JSON.parse(line)); } catch { /* skip a torn line */ }
        }
      }
    }
    // One key's log is already in append order; merge several keys by time (stable).
    if (keys.length > 1) all.sort((a, b) => String(a.t).localeCompare(String(b.t)));
    if (tail) all = all.slice(-tail);
    return all;
  }

  // ---- staleness (D8) -------------------------------------------------------------------------
  // Returns null when the lease is live, else the reason it may be reclaimed.
  function staleReason(rec) {
    if (!rec) return null;
    if (rec.corrupt) return rec.ageMs > CORRUPT_GRACE_MS ? 'corrupt' : null;
    const l = rec.lease;
    const t = now();
    if (l.deadline && t > Date.parse(l.deadline)) return 'deadline';
    if (l.mode === 'session') {
      if (l.expiresAt && t > Date.parse(l.expiresAt)) return 'idle';
      return null;
    }
    const h = l.holder || {};
    // A lease from another machine: PIDs mean nothing here, so it is alive until its deadline.
    if (h.hostname && h.hostname !== hostname) return null;
    const children = Array.isArray(h.childPids) ? h.childPids : [];
    const childAlive = children.some((c) => alive(c));
    let holderDead = !alive(h.pid);
    if (!holderDead && h.pidStart) {
      let cur = startOf(h.pid);
      // A mismatch from the 2 s cache may be stale: re-read live before declaring reuse.
      if (cur && cur !== h.pidStart) cur = startOf(h.pid, { fresh: true });
      if (cur && cur !== h.pidStart) holderDead = true; // PID reuse
    }
    if (holderDead && !childAlive) return h.pidStart && alive(h.pid) ? 'pid-reuse' : 'dead';
    return null;
  }

  // ---- reclaim mutex (D9) ---------------------------------------------------------------------
  function tryMutex(key) {
    const m = mutexPath(key);
    try { io.mkdirSync(m); return true; } catch (e) {
      if (e.code !== 'EEXIST') throw ioError(e, m);
    }
    // An orphaned mutex (older than 30 s) is removed with rename-then-rmdir, then retried once.
    try {
      const st = io.statSync(m);
      if (now() - st.mtimeMs > RECLAIM_LOCK_STALE_MS) {
        const moved = `${m}.stale.${crypto.randomBytes(4).toString('hex')}`;
        io.renameSync(m, moved);
        try { io.rmdirSync(moved); } catch { /* someone else */ }
        io.mkdirSync(m);
        return true;
      }
    } catch { /* lost the race */ }
    return false;
  }
  function releaseMutex(key) { try { io.rmdirSync(mutexPath(key)); } catch { /* gone */ } }
  // Hold the mutex for fn (sync); retries briefly. Returns fn's result, or `fallback` if never acquired.
  /** @param {string} key @param {() => any} fn @param {{ tries?: number, delayMs?: number, fallback?: any }} [o] */
  function withMutexSync(key, fn, { tries = 50, delayMs = 20, fallback } = {}) {
    for (let i = 0; i < tries; i++) {
      if (tryMutex(key)) { try { return fn(); } finally { releaseMutex(key); } }
      sleepSync(delayMs);
    }
    return typeof fallback === 'function' ? fallback() : fallback;
  }

  // Reclaim a stale lease: under the mutex, re-read, and unlink only if it is the same lease and still stale.
  function reclaimIfStale(key, observed, by) {
    if (!tryMutex(key)) return false;
    try {
      const rec = readHolder(key);
      if (!rec) return true; // already free
      const sameLease = observed && observed.lease && rec.lease
        ? rec.lease.leaseId === observed.lease.leaseId
        : !!(observed && observed.corrupt && rec.corrupt && rec.mtimeMs === observed.mtimeMs);
      const reason = staleReason(rec);
      if (!sameLease || !reason) return false;
      writeTombstone(key, (rec.lease || {}).leaseId, { by: by || null, reason });
      io.unlinkSync(holderPath(key));
      /** @type {Partial<import('../types/lease').LeaseRecord>} */
      const l = rec.lease || {};
      logEvent(key, {
        ev: 'reclaimed', leaseId: l.leaseId || null, agent: (l.holder || {}).agent || null,
        purpose: (l.holder || {}).purpose || null, verb: (l.holder || {}).verb, reason, by: by || null,
        heldMs: l.acquiredAt ? now() - Date.parse(l.acquiredAt) : undefined,
      });
      return true;
    } catch (e) { throw ioError(e, holderPath(key)); }
    finally { releaseMutex(key); }
  }

  // ---- queue (D5) -----------------------------------------------------------------------------
  function ticketName(queuedAtMs, leaseId) { return `${String(queuedAtMs).padStart(15, '0')}-${leaseId}.json`; }
  function readTickets(key) {
    let names = [];
    try { names = io.readdirSync(queueDir(key)).filter((n) => n.endsWith('.json')).sort(); }
    catch (e) { if (e.code === 'ENOENT') return []; throw ioError(e, queueDir(key)); }
    const out = [];
    for (const name of names) {
      const p = path.join(queueDir(key), name);
      try {
        const st = io.statSync(p);
        const t = JSON.parse(io.readFileSync(p, 'utf8'));
        out.push({ ...t, file: name, path: p, mtimeMs: st.mtimeMs });
      } catch { /* vanished or torn: skipped this round */ }
    }
    return out;
  }
  // A ticket is dead when its waitUntil has passed, or its PID is dead (or reused) and it has not been
  // touched for the grace period (TICKET_GRACE_MS).
  function ticketDead(t, graceMs) {
    return ticketState(t, { graceMs, now: now(), hostname, alive, startOf }) === 'dead';
  }
  // Ticket adoption: a ticket whose waiter died (PID gone or reused, same host) and that is still inside the
  // grace is taken over by a new waiter with the same agent and purpose, keeping its place (name prefix and
  // queuedAt). The rename claims it atomically, so two adopters cannot share one. Returns the path or null.
  function adoptTicket(key, ticket, graceMs = TICKET_GRACE_MS) {
    const n = now();
    for (const t of readTickets(key)) {
      if (t.agent !== ticket.agent || t.purpose !== ticket.purpose || t.leaseId === ticket.leaseId) continue;
      if (t.hostname && t.hostname !== hostname) continue;
      if (t.waitUntil && n > Date.parse(t.waitUntil)) continue;
      if (!ticketDead(t, -1) || n - t.mtimeMs > graceMs) continue; // owner alive, or past the grace
      const target = path.join(queueDir(key), t.file.replace(/-[^-]*\.json$/, `-${ticket.leaseId}.json`));
      try { io.renameSync(t.path, target); } catch { continue; } // lost the race: try the next one
      try { replaceFile(target, JSON.stringify({ ...ticket, queuedAt: t.queuedAt || ticket.queuedAt })); }
      catch (e) { throw ioError(e, target); }
      return target;
    }
    return null;
  }
  function liveTickets(key, graceMs = TICKET_GRACE_MS) {
    const live = [];
    for (const t of readTickets(key)) {
      if (ticketDead(t, graceMs)) { try { io.unlinkSync(t.path); } catch { /* gone */ } continue; }
      live.push(t);
    }
    return live;
  }

  function listKeys() {
    try {
      return io.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    } catch { return []; }
  }

  function computeEta(holder, queue, events) { return computeEtaAt(holder, queue, events, now()); }

  function statusOf(key) {
    const rec = readHolder(key);
    const queue = readTickets(key).map(({ path: _p, mtimeMs: _m, ...t }) => t);
    const holder = rec && rec.lease ? rec.lease : null;
    const reason = staleReason(rec);
    /** @type {number | null} */
    let etaMs = null; let overdueMs;
    try {
      const eta = computeEta(holder, queue, readEvents({ key }));
      etaMs = eta.etaMs;
      overdueMs = eta.overdueMs;
      queue.forEach((t, i) => { t.etaMs = eta.perTicket[i]; t.etaNote = etaNote(t.etaMs, overdueMs); });
    } catch { /* the ETA is display only */ }
    return { key, holder, corrupt: !!(rec && rec.corrupt), queue, stale: !!reason, staleReason: reason, etaMs, etaNote: etaNote(etaMs, overdueMs), ...(overdueMs !== undefined ? { overdueMs } : {}) };
  }
  /** @param {{ key?: string }} [o] */
  function status({ key } = {}) {
    return (key ? [key] : listKeys()).map(statusOf);
  }

  // Find the key a token currently holds (null if none).
  // A device lane that knows the device identity holds two keys (identity first, then address) under ONE
  // leaseId, so a token can hold several keys; findTokenKeys lists them all, findToken returns the first.
  function findTokenKeys(token) {
    const out = [];
    for (const k of listKeys()) {
      const rec = readHolder(k);
      if (rec && rec.lease && rec.lease.leaseId === token) out.push(k);
    }
    return out;
  }
  function findToken(token) {
    return findTokenKeys(token)[0] || null;
  }

  return {
    dir, env, io, now, hostname, sleep, random, alive, startOf,
    adoptTicket, keyDir, holderPath, queueDir, mutexPath, eventsPath,
    tombDir, ensureKeyDir, readDirId, writeTombstone, isTombstoned, createExclusive, replaceFile, readHolder, writeTmp,
    logEvent, readEvents, staleReason, tryMutex, releaseMutex, withMutexSync, reclaimIfStale,
    ticketName, readTickets, liveTickets, listKeys, status, statusOf, findToken, findTokenKeys, ioError,
  };
}

// ---- acquire ----------------------------------------------------------------------------------
function newLeaseId() { return crypto.randomBytes(12).toString('hex'); } // 96-bit; also the session token

function defaultAgent(env) {
  let user = env.USER || env.USERNAME || 'user';
  try { user = os.userInfo().username || user; } catch { /* keep env */ }
  return `${user}@pid${process.pid}`;
}

// Options (all optional except host/key): host, port, key, mode ('command'), agent, purpose, command
// (argv for the audit record), secrets (strings to redact), waitMs, maxHoldMs, expectMs, serial,
// onWait(snapshot), signal (AbortSignal), env, dir, and test seams (now, isAlive, pidStart, sleep, fs,
// hostname, pid, lookup, timers:false, ticketGraceMs, pollMs).
// LSE-T15: advisory only. After a lease is held and nothing was ahead of us, if the dev channel is already in
// front, someone may be using the device outside a lease: print one stderr line and carry on. Fire-and-forget:
// it never delays or fails the acquire, never touches the lease record, and release() cancels it (the socket
// and timer are unref'd and destroyed on timeout or oversize; a still-connecting socket can keep a library
// process alive for up to the 1 s timeout if release() is never called). Silent when this key saw any end event
// (released, reclaimed, forced, lost) within the last 10 minutes
// (normal leased use leaves the dev channel up), when the warning has nowhere to go (`onWarn: null`), or when
// off (BRIGHTTEST_LEASE_NO_FOREGROUND_CHECK=1, opts.foregroundCheck === false). Never throws.
const FOREGROUND_TIMEOUT_MS = 1000;
const FOREGROUND_MAX_BYTES = 64 * 1024;
const FOREGROUND_RECENT_MS = 10 * 60 * 1000;
// Any way a leased run ended: it may have left the dev channel up on purpose (or by crashing).
const RECENT_ENDS = new Set(['released', 'reclaimed', 'forced', 'lost']);
function foregroundAdvisory(store, key, leaseId, opts, env) {
  /** @type {import('http').ClientRequest | null} */
  let req = null;
  const cancel = () => { try { if (req) req.destroy(); } catch { /* advisory */ } };
  try {
    if (!opts.host || opts.foregroundCheck === false || opts.onWarn === null || env.BRIGHTTEST_LEASE_NO_FOREGROUND_CHECK === '1') return;
    const since = store.now() - FOREGROUND_RECENT_MS;
    if (store.readEvents({ key }).some((e) => e && RECENT_ENDS.has(e.ev) && Date.parse(e.t) >= since)) return;
    const host = stripHostPasswords(String(opts.host).trim());
    const port = opts.port == null || opts.port === '' ? DEFAULT_ECP_PORT : Number(opts.port);
    const warn = opts.onWarn || ((m) => process.stderr.write(m + '\n'));
    const done = (xml) => {
      try {
        const app = require('./e2e/ecp').parseActiveApp(xml);
        if (app.id !== 'dev' && app.uiLocation !== 'dev') return;
        const cur = store.readHolder(key); // still our lease? (a stale line after release is noise)
        if (!cur || !cur.lease || cur.lease.leaseId !== leaseId) return;
        warn(`[brighttest lease] device ${redactText(host, opts.secrets || [])} has the dev channel in the foreground but no brighttest lease holder; another run or tool may be using it`);
      } catch { /* advisory */ }
    };
    req = require('http').get({
      host: host.replace(/^\[|\]$/g, ''), port, path: '/query/active-app', agent: false,
    }, (res) => {
      if (res.statusCode !== 200) { res.destroy(); return; }
      const chunks = [];
      let n = 0;
      res.on('data', (c) => { n += c.length; if (n > FOREGROUND_MAX_BYTES) { res.destroy(); chunks.length = 0; } else chunks.push(c); });
      res.on('end', () => { if (n <= FOREGROUND_MAX_BYTES) done(Buffer.concat(chunks).toString('utf8')); });
      res.on('error', () => {});
    });
    const timer = setTimeout(() => /** @type {import('http').ClientRequest} */ (req).destroy(), FOREGROUND_TIMEOUT_MS);
    timer.unref();
    req.on('socket', (sock) => sock.unref());
    req.on('close', () => clearTimeout(timer));
    req.on('error', () => {});
  } catch { /* advisory */ }
  return cancel;
}

// A device lane that knows the device identity takes TWO leases, identity key first and then the address key,
// both under one leaseId (so one token is one hold). Paths that only know an address (Studio, the MCP server,
// pool picks, status) take the address key alone, so they still collide with an identity-keyed lane; two
// identity-keyed lanes collide on the identity key even when they reach the device by different addresses.
// Options: deviceId (serial / device-id, hashed here) or identityKey (an already hashed `id-…` key, e.g. the
// one remembered for the host when the device-info read failed). With opts.key set: that one key only.
async function acquire(opts = {}) {
  const deviceId = opts.deviceId != null && String(opts.deviceId).trim() !== '' ? opts.deviceId : null;
  const idKey = opts.key ? null : (deviceId ? keyFromIdentity(deviceId) : (typeof opts.identityKey === 'string' && /^id-[0-9a-f]{16}$/.test(opts.identityKey) ? opts.identityKey : null));
  if (!idKey) return acquireOne({ ...opts, deviceId: undefined, identityKey: undefined });
  const store = opts.store || createStore(opts);
  const env = opts.env || process.env;
  const addrKey = await normalizeKey(opts.host, { port: opts.port, lookup: opts.lookup });
  const t0 = store.now();
  const waitMs = opts.waitMs != null ? opts.waitMs : parseDuration(DEFAULTS.wait);
  const base = { ...opts, store, deviceId: undefined, identityKey: undefined };
  // A token that already holds either key: the single-hold rule, a no-op lease (acquireOne checks the token).
  const token = opts.token !== undefined ? opts.token : env.BRIGHTTEST_LEASE;
  if (token) {
    for (const k of [idKey, addrKey]) {
      /** @type {import('../types/lease').HolderRead} */
      let rec = null;
      try { rec = store.readHolder(k); } catch (e) { throw store.ioError(e, store.dir); }
      if (rec && rec.lease && rec.lease.leaseId === token) return acquireOne({ ...base, key: k });
    }
  }
  const first = await acquireOne({ ...base, key: idKey });
  let second;
  let marked = false;
  try {
    second = await acquireOne({
      ...base, host: opts.host, key: addrKey, leaseId: first.leaseId, token: null, foregroundCheck: false,
      waitMs: waitMs === 0 ? 0 : Math.max(0, waitMs - (store.now() - t0)),
      // Queued for the second key while holding the first: say so on the first key's record (waitingOn), so a
      // waiter behind us sees the real blocker, not a device that looks merely busy.
      onBlocked: () => { marked = true; setWaitingOn(store, first, addrKey); },
    });
  } catch (e) {
    try { first.release(); } catch { /* best-effort */ }
    throw e;
  }
  if (marked) setWaitingOn(store, first, null);
  const both = Object.create(first);
  both.keys = [idKey, addrKey];
  both.secondary = second;
  both.release = (why, extra) => {
    let err = null;
    try { second.release(why, extra); } catch (e) { err = e; }
    try { first.release(why, extra); } catch (e) { err = err || e; }
    if (err) throw err;
  };
  both.addChild = (pid) => { first.addChild(pid); second.addChild(pid); };
  both.spawn = (cmd, args, spawnOpts = {}) => {
    const child = first.spawn(cmd, args, spawnOpts);
    if (child && child.pid) second.addChild(child.pid);
    return child;
  };
  both.assertHeld = () => { first.assertHeld(); second.assertHeld(); };
  both.heartbeat = () => { first.heartbeat(); second.heartbeat(); };
  if (typeof first.renew === 'function') both.renew = () => { second.renew(); return first.renew(); };
  Object.defineProperty(both, 'lost', { get: () => !!(first.lost || second.lost) });
  return both;
}

// Record (or clear, with key null) `waitingOn: <key>` in the holder record of a lease we hold. Additive field: old
// readers ignore it. The in-memory record is updated too, so the next heartbeat rewrite keeps it. Best-effort.
function setWaitingOn(store, held, waitKey) {
  try {
    const key = held.key;
    const rec = held.record;
    if (rec) { if (waitKey) rec.waitingOn = waitKey; else delete rec.waitingOn; }
    store.withMutexSync(key, () => {
      const cur = store.readHolder(key);
      if (!cur || !cur.lease || cur.lease.leaseId !== held.leaseId) return false;
      const next = { ...cur.lease };
      if (waitKey) next.waitingOn = waitKey; else delete next.waitingOn;
      store.replaceFile(store.holderPath(key), JSON.stringify(next, null, 2));
      return true;
    }, { tries: 25, fallback: false });
  } catch { /* display only */ }
}

async function acquireOne(opts = {}) {
  const store = opts.store || createStore(opts);
  const env = opts.env || process.env;
  const keyNotes = [...(opts.keyNotes || [])]; // key caveats, written to events.log once the key directory exists
  const deviceId = opts.deviceId;
  const key = opts.key || await normalizeKey(opts.host, {
    port: opts.port, lookup: opts.lookup, deviceId,
    onFallback: (h) => {
      keyNotes.push(`key fallback: could not resolve "${h}"; leased by name, so a process that resolves it (or uses its IP) gets a different key`);
      (opts.onWarn || ((m) => process.stderr.write(m + '\n')))(
        `[brighttest lease] warning: could not resolve "${h}"; leasing it by name. Another process that resolves it (or uses its IP) gets a different lease key, so both may use the device at once. Use the device IP.`);
    },
  });
  if (!opts.key && !deviceId && opts.port != null && opts.port !== '' && Number(opts.port) !== DEFAULT_ECP_PORT) {
    keyNotes.push(`key differs by ECP port: port ${Number(opts.port)} is not the default ${DEFAULT_ECP_PORT}, so key ${key} differs from a lane using the default port on the same device`);
  }
  const mode = opts.mode || 'command';
  const secrets = opts.secrets || [];

  // Re-entrancy: a token in BRIGHTTEST_LEASE that holds THIS key → a no-op lease. A token that holds
  // another key → normal acquire. A token that holds nothing → LEASE_LOST (never a silent unlocked run).
  const token = opts.token !== undefined ? opts.token : env.BRIGHTTEST_LEASE;
  if (token) {
    let rec;
    try { rec = store.readHolder(key); } catch (e) { throw store.ioError(e, store.dir); }
    if (rec && rec.lease && rec.lease.leaseId === token) {
      if (rec.lease.mode === 'session') {
        // A session token past its idle TTL or cap is not valid, even before a waiter reclaims the file.
        const why = store.staleReason(rec);
        if (why) throw new LeaseError('LEASE_LOST', `[brighttest lease] session lease ${token.slice(0, 8)}… on ${key} has expired (${why}); lock the device again`, { key });
        // every use of the token renews the idle TTL, on every key the token holds (identity and address)
        for (const k of new Set([key, ...store.findTokenKeys(token)])) renewSession(store, k, token, { log: false });
      }
      return reentrantLease(store, key, rec.lease, opts);
    }
    if (!store.findToken(token)) {
      throw new LeaseError('LEASE_LOST', `[brighttest lease] lease ${token.slice(0, 8)}… (BRIGHTTEST_LEASE) is no longer held; refusing to run unlocked`, { key });
    }
  }

  // Before the first createExclusive: a signal is only delivered to JS when the loop turns, so with the handlers
  // in place a SIGINT between the create and registerHeld still finds the lease held and releases it.
  installProcessHandlers();
  store.ensureKeyDir(key);
  for (const note of keyNotes) store.logEvent(key, { ev: 'note', note });
  const pid = opts.pid || process.pid;
  const leaseId = opts.leaseId || newLeaseId();
  const t0 = store.now();
  const waitMs = opts.waitMs != null ? opts.waitMs : parseDuration(DEFAULTS.wait);
  const session = mode === 'session';
  const maxHoldMs = checkMaxHold(opts.maxHoldMs != null ? opts.maxHoldMs : parseDuration(session ? DEFAULTS.sessionMax : DEFAULTS.maxHold));
  const idleMs = session ? Math.min(opts.idleMs != null ? opts.idleMs : parseDuration(DEFAULTS.sessionIdle), maxHoldMs) : null;
  const pollMs = opts.pollMs != null ? opts.pollMs : POLL_MS;
  const graceMs = opts.ticketGraceMs != null ? opts.ticketGraceMs : TICKET_GRACE_MS;
  const ident = opts.identity || gitIdentity(opts.cwd || process.cwd());
  const myStart = opts.pidStartValue !== undefined ? opts.pidStartValue : store.startOf(pid);
  const command = redactArgv(opts.command || ['brighttest', ...process.argv.slice(2)], secrets);
  const agent = redactText(opts.agent || env.BRIGHTTEST_AGENT || defaultAgent(env), secrets);
  const purpose = redactText(opts.purpose || env.BRIGHTTEST_PURPOSE || command, secrets);
  const verb = cleanVerb(opts.verb);
  const holder = {
    agent, purpose, verb, pid: session ? null : pid, pidStart: session ? null : (myStart || null), childPids: [],
    hostname: store.hostname, user: safeUser(env), cwd: opts.cwd || process.cwd(),
    worktree: ident.worktree || null, branch: ident.branch || null, command,
    claudeSessionId: env.CLAUDE_SESSION_ID || null,
    ...(opts.kind === 'interactive' ? interactiveFields(opts, store.now()) : {}),
  };
  const base = { agent, purpose, verb };
  let aheadAtQueue = 0; // tickets ahead of ours when we first queued (0 when the lease was free)

  const makeRecord = () => {
    const at = store.now();
    return {
      schema: SCHEMA, leaseId, mode,
      device: { key, host: opts.host ? stripHostPasswords(opts.host) : key, port: opts.host ? (opts.port == null || opts.port === '' ? DEFAULT_ECP_PORT : Number(opts.port)) : null, serialHash: hashSerial(opts.serial) },
      holder,
      acquiredAt: new Date(at).toISOString(),
      heartbeatAt: new Date(at).toISOString(),
      expiresAt: session ? new Date(at + idleMs).toISOString() : null,
      idleMs,
      deadline: new Date(at + maxHoldMs).toISOString(),
      expectMs: opts.expectMs || null,
    };
  };

  const tryLink = () => {
    const rec = makeRecord();
    try { return store.createExclusive(store.holderPath(key), JSON.stringify(rec, null, 2)) ? rec : null; }
    catch (e) { throw store.ioError(e, store.holderPath(key)); }
  };
  // One attempt as head: free → link; stale → reclaim and retry once. Returns the record or null.
  const attempt = () => {
    for (let i = 0; i < 2; i++) {
      const cur = store.readHolder(key);
      if (!cur) { const r = tryLink(); if (r) return r; continue; }
      if (store.staleReason(cur)) { store.reclaimIfStale(key, cur, agent); continue; }
      return null;
    }
    return null;
  };

  const finish = (rec, queued) => {
    const waitedMs = store.now() - t0;
    store.logEvent(key, { ev: 'acquired', leaseId, ...base, waitedMs, queued: !!queued, hostname: store.hostname, mode, queuedAhead: aheadAtQueue });
    const lease = session ? sessionLease(store, key, rec, opts) : heldLease(store, key, rec, opts);
    if (!queued) { // after the lease object (heartbeat, signal release) exists
      const cancel = foregroundAdvisory(store, key, leaseId, opts, env) || (() => {});
      const inner = lease.release;
      lease.release = (...a) => { cancel(); return inner(...a); }; // a released lease leaves no request in flight
    }
    return lease;
  };

  // --wait 0: fail if held OR anyone is queued (no barging).
  if (waitMs === 0) {
    if (store.liveTickets(key, graceMs).length === 0) {
      const rec = attempt();
      if (rec) return finish(rec, false);
    }
    const snap = snapshot(store, key, null);
    if (!opts.quietBusy) store.logEvent(key, { ev: 'timeout', leaseId, ...base, waitedMs: 0, reason: 'busy' });
    throw new LeaseError('BUSY', `[brighttest lease] ${key} is busy (--wait 0)`, { key, snapshot: snap });
  }

  // Enqueue a ticket, then poll: only the head may try to acquire.
  const waitUntil = t0 + waitMs;
  // The ticket content is written to a tmp file first; its name (the FIFO order) is stamped right before the
  // rename that makes it visible, so ticket order matches the order tickets appear to other waiters.
  const ticket = {
    schema: SCHEMA, leaseId, agent, purpose, verb, pid, pidStart: holder.pidStart, hostname: store.hostname,
    cwd: holder.cwd, worktree: holder.worktree, branch: holder.branch, claudeSessionId: holder.claudeSessionId,
    queuedAt: new Date(store.now()).toISOString(), waitUntil: new Date(waitUntil).toISOString(), mode,
  };
  let ticketPath;
  try {
    ticketPath = store.adoptTicket(key, ticket, graceMs);
  } catch (e) { throw store.ioError(e, store.queueDir(key)); }
  if (ticketPath) store.logEvent(key, { ev: 'adopted', leaseId, ...base });
  else try {
    const tmp = store.writeTmp(path.join(store.queueDir(key), leaseId), JSON.stringify(ticket));
    ticketPath = path.join(store.queueDir(key), store.ticketName(store.now(), leaseId));
    store.io.renameSync(tmp, ticketPath);
  } catch (e) { throw store.ioError(e, store.queueDir(key)); }
  const removeTicket = () => { try { store.io.unlinkSync(ticketPath); } catch { /* gone */ } };
  const unregister = registerWaiter(removeTicket);

  let announced = false;
  let settled = opts.settleMs === 0;
  let lastWaitLine = -Infinity;
  try {
    for (;;) {
      if (opts.signal && opts.signal.aborted) {
        throw new LeaseError('CANCELLED', '[brighttest lease] cancelled while waiting', { key });
      }
      const tickets = store.liveTickets(key, graceMs);
      const mine = tickets.findIndex((t) => t.leaseId === leaseId);
      if (mine === -1 && store.now() < waitUntil) {
        // Our ticket vanished (lease dir deleted, or swept): put it back at its original place; retry next poll.
        try { store.ensureKeyDir(key); store.replaceFile(ticketPath, JSON.stringify(ticket)); } catch (e) { throw store.ioError(e, ticketPath); }
      }
      if (mine === 0 && !settled && tickets.length === 1) {
        // Alone in the queue on the first look: re-check once after a moment, so a ticket stamped in the same
        // millisecond (but made visible a hair later) is not overtaken.
        settled = true;
        await store.sleep(SETTLE_MS);
        continue;
      }
      settled = true;
      if (mine === 0) {
        const rec = attempt();
        if (rec) { removeTicket(); return finish(rec, announced); }
      }
      const n = store.now();
      if (!announced) {
        announced = true;
        aheadAtQueue = Math.max(0, mine);
        store.logEvent(key, { ev: 'queued', leaseId, ...base, hostname: store.hostname, mode, queuedAhead: aheadAtQueue });
        if (typeof opts.onBlocked === 'function') { try { opts.onBlocked(key); } catch { /* display only */ } }
      }
      if (n >= waitUntil) {
        const snap = snapshot(store, key, leaseId);
        store.logEvent(key, { ev: 'timeout', leaseId, ...base, waitedMs: n - t0 });
        throw new LeaseError('TIMEOUT', `[brighttest lease] gave up waiting for ${key} after ${formatDuration(n - t0)}`, { key, snapshot: snap });
      }
      if (opts.onWait && n - lastWaitLine >= WAIT_LINE_MS) {
        lastWaitLine = n;
        try { opts.onWait({ ...snapshot(store, key, leaseId), waitUntil: new Date(waitUntil).toISOString() }); } catch { /* display only */ }
      }
      // Touch the ticket: its mtime is the "last seen alive" the adoption grace counts from.
      try { const s = new Date(n); store.io.utimesSync(ticketPath, s, s); } catch { /* recreated next round */ }
      const jitter = Math.round((store.random() * 2 - 1) * POLL_JITTER_MS * (pollMs / POLL_MS));
      await store.sleep(Math.max(1, Math.min(pollMs + jitter, Math.max(1, waitUntil - n))));
    }
  } finally {
    removeTicket();
    unregister();
  }
}

// ---- pool ---------------------------------------------------------------------------------------
// A pool is a list of hosts that are interchangeable. `acquirePool` takes the first free one. FIFO across the
// pool: waiters first queue on one pool gate (a lease on key `pool-<hash of the member keys>`, so the existing
// per-key FIFO queue orders them); only the gate holder scans the members, so the oldest waiter gets the next
// device that frees. The gate is held only while choosing (never while using the device) and is released as
// soon as a member is leased. Options: hosts (array, required), port, plus every `acquire` option; waitMs
// covers the gate wait and the scan together. Returns the member lease with `poolHost` set to the chosen host.
// The member keys of a pool, in list order, and the key of its FIFO gate (`pool-<hash of the sorted member keys>`).
// Shared by acquirePool and Studio (which must see the gate queue to yield to a pool waiter).
/** @param {string[]} hosts @param {{ port?: any, lookup?: any }} [o] */
async function poolKeys(hosts, { port, lookup } = {}) {
  const keys = [];
  for (const h of hosts) keys.push(await normalizeKey(h, { port, lookup }));
  return keys;
}
function poolGateKey(keys) {
  return 'pool-' + crypto.createHash('sha256').update([...keys].sort().join('\n')).digest('hex').slice(0, 12);
}

async function acquirePool(opts = {}) {
  const hosts = Array.isArray(opts.hosts) ? opts.hosts.filter(Boolean) : [];
  if (!hosts.length) throw new LeaseError('USAGE', '[brighttest lease] device pool is empty: set deviceLease.pool in brighttest.json');
  const store = opts.store || createStore(opts);
  const env = opts.env || process.env;
  const keys = await poolKeys(hosts, { port: opts.port, lookup: opts.lookup });
  const gateKey = poolGateKey(keys);
  const waitMs = opts.waitMs != null ? opts.waitMs : parseDuration(DEFAULTS.wait);
  const t0 = store.now();
  const pollMs = opts.pollMs != null ? opts.pollMs : POLL_MS;
  // Identity and pid start are computed once (git / ps spawn): not again per poll while the gate is held.
  const pid = opts.pid || process.pid;
  const identity = opts.identity || gitIdentity(opts.cwd || process.cwd());
  const pidStartValue = opts.pidStartValue !== undefined ? opts.pidStartValue : store.startOf(pid);
  const common = { ...opts, hosts: undefined, store, pid, identity, pidStartValue };
  // A token (BRIGHTTEST_LEASE) holding one member: re-use it, no gate. A token that holds nothing: LEASE_LOST.
  const token = opts.token !== undefined ? opts.token : env.BRIGHTTEST_LEASE;
  if (token) {
    for (let i = 0; i < hosts.length; i++) {
      /** @type {import('../types/lease').HolderRead} */
      let rec = null;
      try { rec = store.readHolder(keys[i]); } catch { /* acquire reports it */ }
      if (rec && rec.lease && rec.lease.leaseId === token) {
        const l = await acquireOne({ ...common, host: hosts[i], key: keys[i] });
        l.poolHost = hosts[i];
        return l;
      }
    }
    if (!store.findToken(token)) {
      throw new LeaseError('LEASE_LOST', `[brighttest lease] lease ${token.slice(0, 8)}… (BRIGHTTEST_LEASE) is no longer held; refusing to run unlocked`, { key: gateKey });
    }
  }
  const graceMs = opts.ticketGraceMs != null ? opts.ticketGraceMs : TICKET_GRACE_MS;
  const memberIdentityKey = (host) => {
    if (opts.identityKeyFor) { try { return opts.identityKeyFor(host) || null; } catch { return null; } }
    try { return require('./device-identity').recalledKey(opts.dir || defaultDir(env), host, opts.port) || null; } catch { return null; }
  };
  // One pass over the members in list order: the first free one is leased (createExclusive is atomic per member).
  // Returns { lease } or { busy } (the last BUSY error, for its snapshot).
  const tryMembers = async () => {
    /** @type {any} */
    let busy = null;
    for (let i = 0; i < hosts.length; i++) {
      try {
        // A member whose identity key is remembered is taken on both keys (identity first), so a pool pick queues
        // with every other taker of that device; no network in the scan (remembered keys only).
        const idKey = memberIdentityKey(hosts[i]);
        const l = await acquire({ ...common, host: hosts[i], ...(idKey ? { identityKey: idKey } : { key: keys[i] }), waitMs: 0, quietBusy: true, token: null });
        l.poolHost = hosts[i];
        return { lease: l };
      } catch (e) {
        if (!(e instanceof LeaseError) || e.code !== 'BUSY') throw e;
        busy = e;
      }
    }
    return { busy };
  };
  // --wait 0 never waits on the gate (its hand-off is a poll away): it scans the members at once and is BUSY only when
  // every member is busy, or when other waiters are queued on the pool (no barging past them).
  if (waitMs === 0) {
    if (store.liveTickets(gateKey, graceMs).length > 0) {
      throw new LeaseError('BUSY', '[brighttest lease] the device pool is busy (--wait 0): other runs are waiting for a device', { key: gateKey, snapshot: { ...snapshot(store, gateKey, null), pool: true } });
    }
    const r = await tryMembers();
    if (r.lease) return r.lease;
    throw r.busy;
  }
  const gate = await acquire({
    ...common, host: gateKey, key: gateKey, token: null, foregroundCheck: false, mode: 'command', exitOnLost: false, quietBusy: false,
    purpose: `pool pick (${hosts.length} devices)`, waitMs, maxHoldMs: waitMs + 120000,
    onWait: opts.onWait ? (snap) => opts.onWait({ ...snap, pool: true }) : undefined,
  });
  try {
    const deadline = t0 + waitMs;
    /** @type {any} */
    let lastBusy = null;
    let lastLine = -Infinity;
    for (;;) {
      const r = await tryMembers();
      if (r.lease) return r.lease;
      lastBusy = r.busy;
      const n = store.now();
      if (n >= deadline) {
        throw new LeaseError('TIMEOUT', `[brighttest lease] gave up waiting for a free device in the pool after ${formatDuration(n - t0)}`, { key: gateKey, snapshot: lastBusy && lastBusy.snapshot });
      }
      if (opts.onWait && lastBusy && lastBusy.snapshot && n - lastLine >= WAIT_LINE_MS) {
        lastLine = n;
        try { opts.onWait({ ...lastBusy.snapshot, waitUntil: new Date(deadline).toISOString() }); } catch { /* display only */ }
      }
      if (opts.signal && opts.signal.aborted) throw new LeaseError('CANCELLED', '[brighttest lease] cancelled while waiting', { key: gateKey });
      await store.sleep(Math.max(1, Math.min(pollMs, deadline - n)));
    }
  } finally { gate.release(); }
}

function safeUser(env) {
  try { return os.userInfo().username; } catch { return env.USER || env.USERNAME || null; }
}

// Holder + queue view for the waiting line and errors.
function snapshot(store, key, myLeaseId) {
  const st = store.statusOf(key);
  const position = myLeaseId ? st.queue.findIndex((t) => t.leaseId === myLeaseId) + 1 + (st.holder ? 1 : 0) : null;
  const mine = myLeaseId ? st.queue.find((t) => t.leaseId === myLeaseId) : null;
  // A holder that is itself queued for another key: name who holds that key (the real blocker).
  /** @type {{ key: string, agent: any, purpose: any } | null} */
  let blocker = null;
  const wk = st.holder && st.holder.waitingOn;
  if (typeof wk === 'string' && wk !== key) {
    try {
      const b = store.statusOf(wk);
      blocker = { key: wk, agent: b.holder ? b.holder.holder.agent : null, purpose: b.holder ? b.holder.holder.purpose : null };
    } catch { blocker = { key: wk, agent: null, purpose: null }; }
  }
  return { ...st, ...(blocker ? { blocker } : {}), position: position || null, ...(mine ? { etaMs: mine.etaMs != null ? mine.etaMs : null, etaNote: mine.etaNote || null } : {}) };
}

// Interactive holder (Studio): optional holder fields. A command holder has none of them (no `kind`).
const ANNOTATE_KEYS = ['yieldAfterMs', 'idleReleaseMs', 'activityAt', 'busy'];
const ANNOTATE_WRITE_MS = 5000;
/** @param {any} o @param {number} nowMs */
function interactiveFields(o, nowMs) {
  const ms = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);
  const f = { kind: 'interactive', yieldAfterMs: ms(o.yieldAfterMs), idleReleaseMs: ms(o.idleReleaseMs), activityAt: new Date(nowMs).toISOString(), busy: false };
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
}

/** True for a holder record written by an interactive session (Studio). @param {any} h */
function isInteractive(h) { return !!h && h.kind === 'interactive'; }

// "interactive: yields to waiters 60s after its last action; last action 12s ago" (null for a command holder).
/** @param {any} h holder.holder @param {number} [nowMs] */
function describeInteractive(h, nowMs = Date.now()) {
  if (!isInteractive(h)) return null;
  const parts = ['interactive'];
  const y = Number(h.yieldAfterMs);
  parts.push(Number.isFinite(y) && y >= 0 ? `yields to waiters ${Math.round(y / 1000)}s after its last action` : 'yields to waiters after its last action');
  const at = Date.parse(h.activityAt);
  const text = parts.join(': ') + (Number.isFinite(at) ? `; last action ${formatDuration(Math.max(0, nowMs - at))} ago` : '');
  return h.busy ? `${text}; busy (a run is in progress)` : text;
}

// The waiting line (stderr), written to be read by agents. Never includes secrets (the record is redacted).
/** @param {any} snap @param {{ waitUntil?: string }} [o] */
function formatWaitLine(snap, { waitUntil } = {}) {
  const lines = [];
  const h = snap.holder;
  if (snap.pool) {
    // A pool gate wait: say it in user terms (the internal pool-<id> key and its holder stay hidden).
    lines.push(`[brighttest lease] waiting for a free device in the pool${snap.queue && snap.queue.length ? `, ${snap.queue.length} queued ahead` : ''}.`);
  } else if (h) {
    const hh = h.holder || {};
    const since = new Date(h.acquiredAt);
    const fmt = (d) => d.toTimeString().slice(0, 8);
    const c = (v) => sanitize(v, 300);
    lines.push(`[brighttest lease] ${c(snap.key)} is held by ${c(hh.agent) || '?'} — "${c(hh.purpose)}"`);
    const where = hh.worktree ? `, worktree ${c(hh.worktree)}${hh.branch ? ` (${c(hh.branch)})` : ''}` : '';
    lines.push(`  since ${fmt(since)} (${formatDuration(Date.now() - since.getTime())}, deadline ${fmt(new Date(h.deadline))})${where}.`);
    const inter = describeInteractive(hh);
    if (inter) lines.push(`  (${c(inter)})`);
    if (snap.blocker) {
      lines.push(`  (it is itself waiting for ${c(snap.blocker.key)}${snap.blocker.agent ? `, held by ${c(snap.blocker.agent)} — "${c(snap.blocker.purpose)}"` : ''})`);
    }
  } else {
    lines.push(`[brighttest lease] ${snap.key} is ${snap.corrupt ? 'being created by another process' : 'free'}${snap.queue.length ? `, ${snap.queue.length} queued ahead` : ''}.`);
  }
  if (snap.position) lines.push(`  You are #${snap.position} in queue${snap.etaMs != null ? `; est. wait ~${formatDuration(snap.etaMs)}` : snap.etaNote ? `; ${snap.etaNote}` : ''}.`);
  if (waitUntil) {
    const left = Date.parse(waitUntil) - Date.now();
    lines.push(`  Waiting up to ${formatDuration(left)} more (BRIGHTTEST_LEASE_WAIT / --wait). Ctrl-C to leave the queue.`);
  }
  return lines.join('\n');
}

// ---- lease objects ----------------------------------------------------------------------------
// A re-entrant (nested) lease: the outer holder owns the file; release is a no-op.
function reentrantLease(store, key, rec, opts) {
  // When this process holds the lease itself (a pool pick, a nested lane), children are recorded in that lease
  // (childPids, so a lost or expired lease kills them); the wrapper never releases it.
  const owner = [...held].find((h) => !h.reentrant && h.leaseId === rec.leaseId) || null;
  return {
    leaseId: rec.leaseId, key, host: opts.host || key, mode: rec.mode, reentrant: true, record: rec,
    release() {}, note() {},
    addChild: (pid) => { if (owner) owner.addChild(pid); },
    killChildren: (graceMs) => (owner ? owner.killChildren(graceMs) : undefined),
    spawn: (cmd, args, spawnOpts = {}) => (owner ? owner.spawn(cmd, args, spawnOpts) : require('child_process').spawn(cmd, args, spawnOpts)),
    assertHeld() {
      const cur = store.readHolder(key);
      if (!cur || !cur.lease || cur.lease.leaseId !== rec.leaseId) {
        throw new LeaseError('LEASE_LOST', `[brighttest lease] lease on ${key} is no longer held`, { key });
      }
    },
    heartbeat() {}, lost: false,
  };
}

// ---- session leases (device lock | renew | unlock) --------------------------------------------
// A session lease has no owner process: no heartbeat, no timers, no exit handlers. It lives in holder.json
// until its idle TTL (expiresAt, pushed forward by every use of the token) or its hard cap (deadline) passes,
// or `device unlock` releases it. The token is the leaseId.
function sessionView(rec) {
  return { leaseId: rec.leaseId, mode: rec.mode, expiresAt: rec.expiresAt, deadline: rec.deadline, acquiredAt: rec.acquiredAt };
}

function sessionLease(store, key, record, opts) {
  return {
    leaseId: record.leaseId, key, host: opts.host || key, mode: 'session', reentrant: false, record,
    lost: false, expired: false,
    release: (why) => releaseSession(store, key, record.leaseId, why || 'unlock'),
    renew: () => renewSession(store, key, record.leaseId),
    note: (text) => store.logEvent(key, { ev: 'note', leaseId: record.leaseId, agent: record.holder.agent, purpose: record.holder.purpose, verb: record.holder.verb, note: String(text) }),
    addChild() {}, killChildren() {}, heartbeat() {},
    spawn: (cmd, args, spawnOpts = {}) => require('child_process').spawn(cmd, args, spawnOpts),
    assertHeld() {
      const cur = store.readHolder(key);
      if (!cur || !cur.lease || cur.lease.leaseId !== record.leaseId) {
        throw new LeaseError('LEASE_LOST', `[brighttest lease] session lease on ${key} is no longer held`, { key });
      }
    },
  };
}

// Under the mutex: still the same session lease and not expired → push expiresAt to now + idle (never past
// the deadline). `log: false` for implicit renewals (a nested call or the hook), which would flood events.log.
// Throws LEASE_LOST (exit 77) when the token holds nothing or has expired, USAGE for a command-mode lease.
function renewSession(store, key, token, { log = true } = {}) {
  let out;
  const got = store.withMutexSync(key, () => {
    const cur = store.readHolder(key);
    if (!cur || !cur.lease || cur.lease.leaseId !== token) {
      throw new LeaseError('LEASE_LOST', `[brighttest lease] lease ${String(token).slice(0, 8)}… is not held`, { key });
    }
    const rec = cur.lease;
    if (rec.mode !== 'session') {
      throw new LeaseError('USAGE', `[brighttest lease] lease ${String(token).slice(0, 8)}… on ${key} is a ${rec.mode} lease; only session leases (device lock) are renewed`, { key });
    }
    const why = store.staleReason(cur);
    if (why) throw new LeaseError('LEASE_LOST', `[brighttest lease] session lease ${String(token).slice(0, 8)}… on ${key} has expired (${why}); lock the device again`, { key });
    const n = store.now();
    const idleMs = rec.idleMs || parseDuration(DEFAULTS.sessionIdle);
    const next = { ...rec, heartbeatAt: new Date(n).toISOString(), expiresAt: new Date(Math.min(n + idleMs, Date.parse(rec.deadline))).toISOString() };
    store.replaceFile(store.holderPath(key), JSON.stringify(next, null, 2));
    if (log) store.logEvent(key, { ev: 'renewed', leaseId: rec.leaseId, agent: rec.holder.agent, purpose: rec.holder.purpose, verb: rec.holder.verb, reason: 'session' });
    out = { key, ...sessionView(next) };
    return true;
  }, { tries: 100, fallback: false });
  if (!got) throw new LeaseError('IO', `[brighttest lease] could not take the reclaim mutex for ${key} (${store.mutexPath(key)})`, { key });
  return out;
}

// Release a session lease by token. Returns true when it was removed. A command lease is refused (USAGE).
function releaseSession(store, key, token, why) {
  let removed = false;
  const got = store.withMutexSync(key, () => {
    const cur = store.readHolder(key);
    if (!cur || !cur.lease || cur.lease.leaseId !== token) return true;
    const rec = cur.lease;
    if (rec.mode !== 'session') {
      throw new LeaseError('USAGE', `[brighttest lease] lease ${String(token).slice(0, 8)}… on ${key} is a ${rec.mode} lease; it is released when its command ends. Use --force --reason "…" to override`, { key });
    }
    store.io.unlinkSync(store.holderPath(key));
    removed = true;
    store.logEvent(key, {
      ev: 'released', leaseId: rec.leaseId, agent: rec.holder.agent, purpose: rec.holder.purpose, verb: rec.holder.verb,
      heldMs: store.now() - Date.parse(rec.acquiredAt), reason: why || 'unlock',
    });
    return true;
  }, { tries: 100, fallback: false });
  if (!got) throw new LeaseError('IO', `[brighttest lease] could not take the reclaim mutex for ${key} (${store.mutexPath(key)})`, { key });
  return removed;
}

// Token-first helpers for the CLI and the hook: find the key the token holds, then renew / release.
function renew(token, opts = {}) {
  const store = opts.store || createStore(opts);
  const keys = token ? store.findTokenKeys(token) : [];
  if (!keys.length) throw new LeaseError('LEASE_LOST', `[brighttest lease] lease ${String(token || '').slice(0, 8)}… is not held`);
  let out;
  for (const key of keys) { const r = renewSession(store, key, token, { log: opts.log !== false }); out = out || r; }
  return out;
}

function unlock(token, opts = {}) {
  const store = opts.store || createStore(opts);
  const keys = token ? store.findTokenKeys(token) : [];
  if (!keys.length) throw new LeaseError('LEASE_LOST', `[brighttest lease] lease ${String(token || '').slice(0, 8)}… is not held`);
  const key = keys[0];
  const cur = store.readHolder(key);
  if (cur && cur.lease && cur.lease.mode === 'session') {
    const why = store.staleReason(cur);
    if (why) throw new LeaseError('LEASE_LOST', `[brighttest lease] session lease ${String(token).slice(0, 8)}… on ${key} had already expired (${why}); nothing to unlock`, { key });
  }
  for (const k of keys.slice().reverse()) releaseSession(store, k, token, 'unlock');
  return { key };
}

// Is this token a live lease right now? A session past its idle TTL or cap is not. With `renew`, a valid
// session is also kept alive (the hook passes it for every command that carries the token).
function tokenValid(token, opts = {}) {
  const store = opts.store || createStore(opts);
  const keys = token ? store.findTokenKeys(token) : [];
  if (!keys.length) return false;
  for (const key of keys) {
    const cur = store.readHolder(key);
    if (!cur || !cur.lease || store.staleReason(cur)) return false;
    if (opts.renew && cur.lease.mode === 'session') {
      try { renewSession(store, key, token, { log: false }); } catch { return false; }
    }
  }
  return true;
}

// A held lease: heartbeat (LOST detection + re-assert), self-expiry before the deadline, release.
function heldLease(store, key, record, opts) {
  let rec = record;
  let released = false;
  const timers = [];
  const lease = {
    leaseId: rec.leaseId, key, host: opts.host || key, mode: rec.mode, reentrant: false,
    get record() { return rec; },
    lost: false, expired: false,
    onLost: opts.onLost || null, onExpire: opts.onExpire || null,
    release: (why, extra) => release(why, extra),
    // An audit note for this lease in events.log (not a state change).
    note: (text) => store.logEvent(key, { ev: 'note', leaseId: rec.leaseId, agent: rec.holder.agent, purpose: rec.holder.purpose, verb: rec.holder.verb, note: String(text) }),
    addChild: (pid) => addChild(pid),
    annotate: (patch) => annotate(patch),
    assertHeld: () => {
      if (lease.lost) throw new LeaseError('LEASE_LOST', `[brighttest lease] lease on ${key} was lost`, { key });
    },
    heartbeat: () => heartbeat(),
    // Spawn a child in its own process group and register it (childPids) before it can do anything.
    spawn: (cmd, args, spawnOpts = {}) => {
      const { spawn } = require('child_process');
      const child = spawn(cmd, args, { ...spawnOpts, detached: process.platform !== 'win32' });
      if (child.pid) addChild(child.pid);
      return child;
    },
    killChildren: (graceMs) => killChildren(rec.holder.childPids, graceMs),
  };
  // Without explicit handlers a lost or expired command lease aborts the process (exit 77).
  if (opts.exitOnLost !== false && !lease.onLost) lease.onLost = (reason) => abortProcess(lease, `lease lost (${reason})`);
  if (opts.exitOnLost !== false && !lease.onExpire) {
    lease.onExpire = () => abortProcess(lease, 'lease reached its deadline (--max)');
  }

  let dirId = store.readDirId(key);
  // Write holder.json only while it is still ours. Under the mutex so a concurrent reclaim or force cannot be
  // overwritten; skipped (next beat) when the mutex is busy. Returns true when written.
  function writeOwn() {
    return store.withMutexSync(key, () => {
      const cur = store.readHolder(key);
      if (!cur || !cur.lease || cur.lease.leaseId !== rec.leaseId || store.isTombstoned(key, rec.leaseId)) return false;
      store.replaceFile(store.holderPath(key), JSON.stringify(rec, null, 2));
      return true;
    }, { tries: 25, fallback: false });
  }
  function markLost(reason) {
    if (lease.lost || released) return;
    lease.lost = true;
    stopTimers();
    store.logEvent(key, { ev: 'lost', leaseId: rec.leaseId, agent: rec.holder.agent, purpose: rec.holder.purpose, verb: rec.holder.verb, reason });
    released = true;
    if (lease.onLost) lease.onLost(reason, lease);
  }
  // Every 15 s, under the mutex: still ours → rewrite heartbeatAt; someone else's, tombstoned (reclaimed or
  // force-unlocked) or holder.json gone with the lease directory intact → LOST. Only when the lease
  // directory itself was deleted (its dir.id changed) is the lease re-asserted with link().
  function heartbeat() {
    if (released) return;
    const n = store.now();
    if (n >= Date.parse(rec.deadline) - EXPIRE_MARGIN_MS) return expire();
    /** @type {string | null} */
    let verdict = null; // string = LOST reason
    let recheck = false; // holder.json missing, directory intact: re-read a few times before LOST
    try { store.io.statSync(store.keyDir(key)); } catch (e) { if (e.code === 'ENOENT') { try { store.ensureKeyDir(key); } catch { return; } } }
    const ran = store.withMutexSync(key, () => {
      let cur;
      try { cur = store.readHolder(key); } catch { return true; }
      if (cur && cur.lease && cur.lease.leaseId === rec.leaseId && !store.isTombstoned(key, rec.leaseId)) {
        rec = { ...rec, heartbeatAt: new Date(n).toISOString() };
        try { store.replaceFile(store.holderPath(key), JSON.stringify(rec, null, 2)); } catch { /* next beat */ }
        return true;
      }
      if (cur && cur.lease) { verdict = 'held by another lease'; return true; }
      if (store.isTombstoned(key, rec.leaseId)) { verdict = 'released by force or reclaim'; return true; }
      if (cur) { verdict = 'lease file gone'; return true; } // corrupt
      // holder.json is missing. Re-assert only if the whole lease directory was deleted.
      const id = store.readDirId(key);
      if (dirId && id && id === dirId) { verdict = 'lease file gone'; recheck = true; return true; }
      try {
        store.ensureKeyDir(key);
        rec = { ...rec, heartbeatAt: new Date(n).toISOString() };
        if (store.createExclusive(store.holderPath(key), JSON.stringify(rec, null, 2))) {
          dirId = store.readDirId(key);
          store.logEvent(key, { ev: 'renewed', leaseId: rec.leaseId, agent: rec.holder.agent, purpose: rec.holder.purpose, verb: rec.holder.verb, reason: 'reasserted' });
          return true;
        }
        const now2 = store.readHolder(key);
        verdict = now2 && now2.lease && now2.lease.leaseId === rec.leaseId ? null : 'held by another lease';
      } catch { verdict = 'lease file gone'; }
      return true;
    }, { tries: 25, fallback: false });
    if (ran && verdict && recheck) verdict = recheckMissing(verdict);
    if (ran && verdict) markLost(verdict);
  }
  // A missing holder.json with an unchanged dir.id may be a transient gap, so re-read it a bounded number of
  // times (HOLDER_RECHECK_TRIES reads, HOLDER_RECHECK_MS apart, outside the mutex) before declaring LOST. Back
  // in place and ours → not lost; another lease or a tombstone → that reason; still missing → the original one.
  function recheckMissing(orig) {
    const sleep = opts.recheckSleep || sleepSync;
    const until = Date.now() + HOLDER_RECHECK_DEADLINE_MS;
    for (let i = 0; i < HOLDER_RECHECK_TRIES && Date.now() <= until; i++) {
      sleep(HOLDER_RECHECK_MS);
      /** @type {import('../types/lease').HolderRead} */
      let cur = null;
      try { cur = store.readHolder(key); } catch { /* keep looking */ }
      if (!cur) continue;
      if (store.isTombstoned(key, rec.leaseId)) return 'released by force or reclaim';
      if (cur.lease && cur.lease.leaseId === rec.leaseId) return null;
      return cur.lease ? 'held by another lease' : orig;
    }
    return orig;
  }
  function expire() {
    if (released) return;
    lease.expired = true;
    stopTimers();
    store.logEvent(key, { ev: 'lost', leaseId: rec.leaseId, agent: rec.holder.agent, purpose: rec.holder.purpose, verb: rec.holder.verb, reason: 'deadline' });
    if (lease.onExpire) lease.onExpire(lease);
    release('expired');
  }
  // Merge interactive-holder fields into the in-memory record; write at once only if the last annotate write was
  // 5 s or more ago, else the next heartbeat writes it. Never touches the lease id, deadline or expiry.
  let lastAnnotateWrite = 0;
  function annotate(patch) {
    if (released || lease.lost || !patch) return false;
    const clean = {};
    for (const k of ANNOTATE_KEYS) if (patch[k] !== undefined) clean[k] = patch[k];
    if (patch.kind === 'interactive') clean.kind = 'interactive';
    if (!Object.keys(clean).length) return false;
    rec = { ...rec, holder: { ...rec.holder, ...clean } };
    const n = store.now();
    if (n - lastAnnotateWrite < ANNOTATE_WRITE_MS) return false;
    lastAnnotateWrite = n;
    try { return writeOwn(); } catch { return false; }
  }
  function addChild(pid) {
    if (!pid || released) return;
    rec = { ...rec, holder: { ...rec.holder, childPids: [...new Set([...(rec.holder.childPids || []), pid])] } };
    try { writeOwn(); } catch { /* best-effort: the next heartbeat writes it */ }
  }
  // Between heartbeats, notice a deleted holder file at once (fs.watch on the key dir, plus a cheap 1 s
  // existence check where watching is unreliable) and re-assert before a waiter can link a new lease.
  /** @type {import('fs').FSWatcher | null} */
  let watcher = null;
  function checkPresent() {
    if (released) return;
    try { store.io.statSync(store.holderPath(key)); } catch { heartbeat(); watchKeyDir(); }
  }
  function watchKeyDir() {
    if (released || opts.timers === false || store.io !== fs) return;
    try { if (watcher) watcher.close(); } catch { /* closed */ }
    try {
      watcher = fs.watch(store.keyDir(key), { persistent: false }, () => checkPresent());
      watcher.on('error', () => { try { /** @type {import('fs').FSWatcher} */ (watcher).close(); } catch { /* closed */ } watcher = null; });
    } catch { watcher = null; }
  }
  function stopTimers() {
    while (timers.length) { const t = timers.pop(); clearInterval(t); clearTimeout(t); }
    if (watcher) { try { watcher.close(); } catch { /* closed */ } watcher = null; }
  }
  function release(why, extra) {
    if (released) return false;
    released = true;
    stopTimers();
    const id = rec.leaseId;
    const doUnlink = () => {
      const cur = store.readHolder(key);
      if (cur && cur.lease && cur.lease.leaseId === id) { store.io.unlinkSync(store.holderPath(key)); return true; }
      return false;
    };
    let removed = false;
    try {
      removed = store.withMutexSync(key, doUnlink, { fallback: doUnlink });
    } catch { /* best-effort */ }
    if (removed) {
      store.logEvent(key, {
        ev: 'released', leaseId: id, agent: rec.holder.agent, purpose: rec.holder.purpose, verb: rec.holder.verb,
        heldMs: store.now() - Date.parse(rec.acquiredAt), reason: why || undefined,
        ...(extra && Number.isInteger(extra.exitCode) ? { exitCode: extra.exitCode } : {}),
      });
    }
    if (lease._onRelease) lease._onRelease();
    return removed;
  }

  if (opts.timers !== false) {
    const hb = setInterval(heartbeat, opts.heartbeatMs || HEARTBEAT_MS);
    if (hb.unref) hb.unref();
    timers.push(hb);
    const ms = Date.parse(rec.deadline) - EXPIRE_MARGIN_MS - store.now();
    const ex = setTimeout(expire, Math.max(0, ms));
    if (ex.unref) ex.unref();
    timers.push(ex);
    const chk = setInterval(checkPresent, 1000);
    if (chk.unref) chk.unref();
    timers.push(chk);
    watchKeyDir();
  }
  registerHeld(lease);
  return lease;
}

// ---- child process groups ---------------------------------------------------------------------
// Children started under a lease get their own process group (detached on POSIX) so the holder can kill
// the whole group; they are recorded in holder.childPids so a SIGKILLed wrapper whose child lives on still
// counts as alive (D8 rule 1).
function killGroup(pid, signal = 'SIGTERM') {
  if (!pid) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', timeout: 5000 }); } catch { /* gone */ }
    return;
  }
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* gone */ } }
}
// SIGTERM each group, give them up to graceMs to exit, then SIGKILL what is left (sync: runs in exit paths).
function killChildren(pids, graceMs = 2000) {
  const list = (pids || []).filter(Boolean);
  if (!list.length) return;
  for (const p of list) killGroup(p, 'SIGTERM');
  const until = Date.now() + graceMs;
  while (Date.now() < until && list.some((p) => isAlive(p))) sleepSync(50);
  for (const p of list) if (isAlive(p)) killGroup(p, 'SIGKILL');
}

// ---- process-wide registry: held leases and waiting tickets -----------------------------------
// Installed once: on SIGINT/SIGTERM/SIGHUP kill child groups, release synchronously, drop tickets, then
// re-raise; on exit, best-effort release. SIGKILL cannot be handled: the PID check recovers it.
const waiters = new Set();
const held = new Set();
let handlersInstalled = false;
function registerWaiter(cleanup) {
  installProcessHandlers();
  waiters.add(cleanup);
  return () => waiters.delete(cleanup);
}
function registerHeld(lease) {
  installProcessHandlers();
  held.add(lease);
  lease._onRelease = () => held.delete(lease);
}
/** @param {{ kill?: boolean }} [o] */
function cleanupAll({ kill } = {}) {
  for (const w of [...waiters]) { try { w(); } catch { /* best-effort */ } }
  waiters.clear();
  for (const l of [...held]) {
    if (kill) { try { killChildren(l.record.holder.childPids, 1000); } catch { /* best-effort */ } }
    try { l.release('signal'); } catch { /* best-effort */ }
  }
  held.clear();
}
function installProcessHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const onSignal = () => {
      cleanupAll({ kill: true });
      // Re-raise with the default disposition so the exit status reflects the signal.
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    };
    process.once(sig, onSignal);
  }
  process.on('exit', () => cleanupAll({ kill: false }));
}

// Default reaction when a command lease is lost or self-expires: kill the children, say why, exit 77.
function abortProcess(lease, why) {
  try { killChildren(lease.record.holder.childPids, 1000); } catch { /* best-effort */ }
  try { lease.release('expired'); } catch { /* best-effort */ }
  process.stderr.write(`[brighttest lease] ${why} on ${lease.key}; stopped the command (exit 77).\n`);
  process.exit(LEASE_EXIT.lost);
}

// ---- convenience ------------------------------------------------------------------------------
async function withLease(opts, fn) {
  const lease = await acquire(opts);
  try { return await fn(lease); } finally { lease.release(); }
}

// Human override (`device unlock --force`): remove any lease on a key, audited. Refuses a live lease
// without a reason. `kill` terminates the holder process and its child groups first (same machine only).
function forceRelease(opts = {}) {
  const store = opts.store || createStore(opts);
  const key = opts.key;
  let result = { released: false, victim: null };
  // A key directory that does not exist is not held (no mutex, no error).
  try { store.io.statSync(store.keyDir(key)); } catch (e) { if (e && e.code === 'ENOENT') return result; /* EACCES etc.: the normal path reports it */ }
  const work = () => {
    const rec = store.readHolder(key);
    if (!rec) return;
    const stale = store.staleReason(rec);
    if (!stale && !opts.reason) {
      throw new LeaseError('USAGE', `[brighttest lease] ${key} is held by a live process; --force needs --reason "…"`, { key });
    }
    const l = rec.lease || {};
    const h = l.holder || {};
    if (opts.kill && h.hostname === store.hostname) {
      if (h.pid && h.pid !== process.pid) killGroup(h.pid, 'SIGTERM');
      killChildren(h.childPids, 2000);
      if (h.pid && h.pid !== process.pid && isAlive(h.pid)) killGroup(h.pid, 'SIGKILL');
    }
    store.writeTombstone(key, l.leaseId, { by: redactText(opts.by || defaultAgent(store.env)), reason: 'forced' });
    try { store.io.unlinkSync(store.holderPath(key)); } catch (e) { if (e.code !== 'ENOENT') throw e; } // killed holder may have released
    result = { released: true, victim: l.leaseId || null, stale: stale || null };
    store.logEvent(key, {
      ev: 'forced', leaseId: l.leaseId || null, agent: h.agent || null, purpose: h.purpose || null, verb: h.verb,
      by: redactText(opts.by || defaultAgent(store.env)), reason: redactText(opts.reason || `stale (${stale})`, opts.secrets || []),
      killed: !!opts.kill,
    });
  };
  const got = store.withMutexSync(key, () => { work(); return true; }, { tries: 100, fallback: false });
  if (!got) throw new LeaseError('IO', `[brighttest lease] could not take the reclaim mutex for ${key} (${store.mutexPath(key)})`, { key });
  return result;
}

// Effective lease settings in ms: flag > env (BRIGHTTEST_LEASE_WAIT) > brighttest.json deviceLease > defaults.
/** @param {{ cfg?: any, env?: NodeJS.ProcessEnv, flags?: Record<string, any> }} [o] */
function resolveSettings({ cfg, env = process.env, flags = {} } = {}) {
  const c = { ...DEFAULTS, ...((cfg && cfg.deviceLease) || {}) };
  const pick = (flag, envVal, cfgVal) => parseDuration(flag != null ? flag : envVal != null && envVal !== '' ? envVal : cfgVal);
  return {
    enabled: c.enabled !== false,
    waitMs: pick(flags.wait, env.BRIGHTTEST_LEASE_WAIT, c.wait),
    maxHoldMs: checkMaxHold(pick(flags.max, null, c.maxHold)),
    idleMs: pick(flags.idle, null, c.sessionIdle),
    sessionMaxMs: checkMaxHold(pick(flags.max, null, c.sessionMax)),
    expectMs: flags.expect != null ? parseDuration(flags.expect) : null,
    hygiene: flags.noHygiene ? 'none' : (c.hygiene || 'home'),
    studioIdleMs: parseDuration(c.studioIdle),
    studioYieldMs: parseDuration(c.studioYield),
  };
}

function status(opts = {}) {
  const store = opts.store || createStore(opts);
  return store.status({ key: opts.key });
}

function readEvents(opts = {}) {
  const store = opts.store || createStore(opts);
  return store.readEvents({ key: opts.key, tail: opts.tail });
}

module.exports = {
  SCHEMA, DEFAULTS, TICKET_GRACE_MS, LeaseError, exitCodeFor, LEASE_EXIT,
  parseDuration, formatDuration, redactArgv, redactText, stripHostPasswords, hashSerial,
  keyFromAddress, keyFromIdentity, normalizeKey, isAlive, pidStart, clearPidStartCache, gitIdentity, defaultDir,
  ticketState, computeEta: computeEtaAt, etaNote, verbOf, createStore, acquire, acquirePool, poolKeys, poolGateKey, withLease, renew, unlock, tokenValid, status, readEvents, forceRelease, resolveSettings, formatWaitLine, describeInteractive, isInteractive, newLeaseId,
  killChildren, killGroup, _waiters: waiters, _held: held,
};
