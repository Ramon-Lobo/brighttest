'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const lease = require('./device-lease');

// Read-only view of the device lease system: one JSON "board" built from the lease folder and the per-key
// events.log files. It shows devices (held, free, stale), who holds each one and for how long, the line
// waiting for it, and the recent runs with how long each waited and held.
//
// This module only LOOKS. It never takes a lease, never creates the lease folder, never deletes a dead ticket,
// never reclaims a stale holder and never writes an event. It uses only the store's read functions
// (readHolder, readTickets, staleReason, listKeys) and its own event reader, which opens, reads and closes a
// file each time so it can never block the lease's log rotation (a rename) on Windows.

const SCHEMA = 'brighttest-lease-board/v1';
const DAY_MS = 24 * 3600 * 1000;
const IDLE_HIDE_MS = 7 * DAY_MS;
const END_EVENTS = new Set(['released', 'lost', 'reclaimed', 'forced']);
const POOL_KEY = /^pool-[0-9a-f]{12}$/;
const ID_KEY = /^id-[0-9a-f]{16}$/;

// ---- small helpers ----------------------------------------------------------------------------
// Loopback address keys: 127.x.x.x, localhost, and ::1 (as keyFromAddress writes it, with ':' as '_').
function isLoopbackName(name) {
  const n = String(name || '').toLowerCase().replace(/_p\d+$/, '');
  return /^127\./.test(n) || n === 'localhost' || n === '__1' || n === '0_0_0_0_0_0_0_1' || n === '::1';
}
// Host part of an address key or cache name (drops the _p<port> suffix); null for identity and pool keys.
function hostOfKey(key) {
  if (ID_KEY.test(key) || POOL_KEY.test(key)) return null;
  return String(key).replace(/_p\d+$/, '');
}
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const tsOf = (e) => { const t = Date.parse(e && e.t); return Number.isFinite(t) ? t : null; };
function shortDir(dir) {
  const home = os.homedir();
  return home && (dir === home || dir.startsWith(home + path.sep)) ? '~' + dir.slice(home.length) : dir;
}

// ---- incremental event reader -----------------------------------------------------------------
// Per key, cached by (size, mtime). Only the bytes appended since the last read are parsed. A smaller size or a
// changed events.log.1 means the log rotated: both files are read again. A torn last line (no newline yet) is
// left alone until its newline arrives. Reads use open/read/close and never keep a handle.
function createEventReader(io) {
  const cache = new Map(); // events.log path -> { rotMtime, rotSize, offset, events }

  function statOrNull(p) { try { return io.statSync(p); } catch { return null; } }

  function readRange(p, from, to) {
    let fd;
    try {
      fd = io.openSync(p, 'r');
      const buf = Buffer.alloc(Math.max(0, to - from));
      let got = 0;
      while (got < buf.length) {
        const n = io.readSync(fd, buf, got, buf.length - got, from + got);
        if (!n) break;
        got += n;
      }
      return buf.subarray(0, got);
    } catch { return Buffer.alloc(0); }
    finally { if (fd !== undefined) { try { io.closeSync(fd); } catch { /* ignore */ } } }
  }
  // Parse complete lines of buf; returns { events, used } where used = bytes up to the last newline.
  function parseLines(buf) {
    const last = buf.lastIndexOf(0x0a);
    if (last < 0) return { events: [], used: 0 };
    const events = [];
    for (const line of buf.subarray(0, last).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (e && typeof e === 'object') events.push(e); } catch { /* torn or junk line */ }
    }
    return { events, used: last + 1 };
  }

  function read(logPath) {
    const rot = statOrNull(logPath + '.1');
    const cur = statOrNull(logPath);
    const rotMtime = rot ? rot.mtimeMs : null;
    const rotSize = rot ? rot.size : null;
    let c = cache.get(logPath);
    const rotated = c && (c.rotMtime !== rotMtime || c.rotSize !== rotSize || (cur ? cur.size < c.offset : c.offset > 0));
    if (!c || rotated) {
      c = { rotMtime, rotSize, offset: 0, events: [] };
      cache.set(logPath, c);
      if (rot) c.events.push(...parseLines(readRange(logPath + '.1', 0, rot.size)).events);
    }
    if (cur && cur.size > c.offset) {
      const { events, used } = parseLines(readRange(logPath, c.offset, cur.size));
      c.events.push(...events);
      c.offset += used;
    }
    return c.events;
  }
  return { read, forget: () => cache.clear() };
}

// ---- the view ---------------------------------------------------------------------------------
// createView({ dir, env, cfg, now, fs, isAlive, pidStart, hostname, machine, knownDevices, store })
//   snapshot({ host, all, historyN = 10, statsWindowMs = 24h }) -> Board   (sync, no network)
//   close()
// `knownDevices()` returns [{ host, name }] (default: the saved device list without passwords).
function createView(o = {}) {
  const env = o.env || process.env;
  const io = o.fs || fs;
  const now = o.now || (() => Date.now());
  const store = o.store || lease.createStore({
    dir: o.dir, env, fs: io, now, isAlive: o.isAlive, pidStart: o.pidStart, hostname: o.hostname,
  });
  const machine = o.machine || o.hostname || os.hostname();
  const reader = createEventReader(io);
  const dirHidden = (name) => !name || name.startsWith('.');

  function known() {
    if (o.knownDevices) { try { return o.knownDevices() || []; } catch { return []; } }
    try { return require('./devices').cachedDevices().map((d) => ({ host: d.host, name: d.name })); } catch { return []; }
  }
  function identityMap() {
    let m = {};
    try { m = JSON.parse(io.readFileSync(path.join(store.dir, 'identity-cache.json'), 'utf8')) || {}; } catch { /* none */ }
    const out = [];
    for (const [name, key] of Object.entries(m)) {
      if (typeof key === 'string' && ID_KEY.test(key)) out.push({ name: String(name).toLowerCase(), key });
    }
    return out;
  }
  const addrKeyOf = (host, port) => lease.keyFromAddress(host, port);

  function snapshot(opts = {}) {
    const t = now();
    const historyN = opts.historyN != null ? opts.historyN : 10;
    const windowMs = opts.statsWindowMs != null ? opts.statsWindowMs : DAY_MS;
    const dirKeys = store.listKeys().filter((k) => !dirHidden(k));
    const dirSet = new Set(dirKeys);

    // 1. Union-find over keys so an identity key and the address key(s) of the same device are one device.
    const parent = new Map();
    const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
    const add = (k) => { if (!parent.has(k)) parent.set(k, k); return k; };
    const union = (a, b) => { const ra = find(add(a)); const rb = find(add(b)); if (ra !== rb) parent.set(rb, ra); };
    for (const k of dirKeys) add(k);

    const hostsOf = new Map();  // key -> Set(host strings)
    const knownKeys = new Set(); // keys the user knows about (so idle ones stay visible)
    const labels = new Map();    // key -> devices.json name
    const addHost = (k, h) => { if (!hostsOf.has(k)) hostsOf.set(k, new Set()); hostsOf.get(k).add(h); };

    for (const { name, key } of identityMap()) {
      const host = name.replace(/_p\d+$/, '');
      const ak = lease.keyFromAddress(host, (/_p(\d+)$/.exec(name) || [])[1]);
      union(key, ak);
      addHost(key, host); addHost(ak, host);
      if (!isLoopbackName(name)) { knownKeys.add(key); knownKeys.add(ak); }
    }
    for (const d of known()) {
      if (!d || !d.host) continue;
      const host = lease.stripHostPasswords(d.host).trim();
      const ak = addrKeyOf(host);
      add(ak); addHost(ak, host); knownKeys.add(ak);
      if (d.name) labels.set(ak, d.name);
    }
    const poolHosts = (o.cfg && o.cfg.deviceLease && Array.isArray(o.cfg.deviceLease.pool)) ? o.cfg.deviceLease.pool : [];
    for (const h of [...poolHosts, env.ROKU_HOST].filter(Boolean)) {
      const host = lease.stripHostPasswords(String(h)).trim();
      const ak = addrKeyOf(host);
      add(ak); addHost(ak, host); knownKeys.add(ak);
    }

    // 2. Live state per key (read-only): holder, tickets, stale reason, newest log time.
    const live = new Map();
    const poolRows = [];
    let transient = null;
    for (const k of dirKeys) {
      let rec = null; let tickets = [];
      try { rec = store.readHolder(k); } catch (e) { transient = transient || e.message; }
      try { tickets = store.readTickets(k); } catch (e) { transient = transient || e.message; }
      let lastEvent = null;
      for (const f of ['events.log', 'events.log.1']) {
        try { const st = io.statSync(path.join(store.dir, k, f)); lastEvent = Math.max(lastEvent || 0, st.mtimeMs); } catch { /* none */ }
      }
      live.set(k, { rec, tickets, lastEvent });
      if (rec && rec.lease && rec.lease.device) {
        const d = rec.lease.device;
        if (d.host && !ID_KEY.test(String(d.host)) && d.host !== k) {
          const ak = addrKeyOf(String(d.host), d.port == null ? undefined : d.port);
          union(k, ak); addHost(k, String(d.host)); addHost(ak, String(d.host));
        } else if (d.host && d.host === k && !ID_KEY.test(k)) addHost(k, d.host);
      }
    }
    for (const k of dirKeys) { if (!ID_KEY.test(k) && !POOL_KEY.test(k) && !hostsOf.has(k)) addHost(k, hostOfKey(k)); }

    // 3. Group keys into devices.
    const groups = new Map(); // root -> [keys]
    for (const k of parent.keys()) {
      if (POOL_KEY.test(k)) continue;
      const r = find(k);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(k);
    }
    const idle = (keys) => keys.every((k) => { const l = live.get(k); return !l || (!(l.rec) && !l.tickets.length); });
    const hostOfGroup = (keys) => { for (const k of keys) { const h = hostsOf.get(k); if (h && h.size) return [...h][0]; } return null; };

    const devices = [];
    let hiddenKeys = 0;
    const eventsOf = (keys) => {
      const seen = new Set(); const out = [];
      for (const k of keys) {
        for (const e of reader.read(path.join(store.dir, k, 'events.log'))) {
          const id = e.leaseId ? `${e.ev}|${e.leaseId}` : null;
          if (id && e.ev !== 'note' && e.ev !== 'renewed') { if (seen.has(id)) continue; seen.add(id); }
          out.push(e);
        }
      }
      return out.map((e, i) => ({ e, i })).sort((a, b) => ((tsOf(a.e) || 0) - (tsOf(b.e) || 0)) || (a.i - b.i)).map((x) => x.e);
    };

    for (const keys of groups.values()) {
      // identity keys first, then address keys, each sorted
      keys.sort((a, b) => (ID_KEY.test(b) - ID_KEY.test(a)) || (a < b ? -1 : 1));
      const heldNow = !idle(keys);
      const hosts = [...new Set(keys.flatMap((k) => [...(hostsOf.get(k) || [])]))].filter(Boolean);
      const loop = hosts.length ? hosts.every(isLoopbackName) : keys.every(isLoopbackName);
      const newest = Math.max(0, ...keys.map((k) => (live.get(k) || {}).lastEvent || 0));
      const isKnown = keys.some((k) => knownKeys.has(k));
      const wanted = opts.host && (hosts.some((h) => h.toLowerCase() === String(opts.host).toLowerCase()) || keys.includes(opts.host));
      let show = true;
      if (opts.host) show = !!wanted;
      else if (!opts.all && !heldNow) {
        if (loop) show = false;
        else if (!isKnown && (!newest || t - newest > IDLE_HIDE_MS)) show = false;
      }
      if (!show) { hiddenKeys += keys.filter((k) => dirSet.has(k)).length; continue; }
      devices.push(buildDevice(keys, hosts, live, labels, eventsOf, t, historyN, windowMs));
    }
    devices.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

    // 4. Pool gate rows (never devices, never in history).
    for (const k of dirKeys.filter((x) => POOL_KEY.test(x))) {
      const l = live.get(k);
      if (!l.rec && !l.tickets.length) continue;
      const events = eventsOf([k]);
      const q = buildQueue(l.tickets, l.rec && l.rec.lease ? l.rec.lease : null, events, t);
      poolRows.push({ size: poolHosts.length || null, queueLength: q.queueLength, queue: q.queue });
    }

    return {
      schema: SCHEMA, at: iso(t), dir: shortDir(store.dir), machine, devices, pools: poolRows,
      hidden: { keys: hiddenKeys, why: 'loopback or idle > 7d; --all to show' },
      ...(transient ? { error: transient } : {}),
    };
  }

  function ticketCtx(t) { return { now: t, hostname: store.hostname, alive: store.alive, startOf: store.startOf }; }

  function buildQueue(tickets, holder, events, t) {
    const seen = new Set();
    const uniq = [];
    for (const k of tickets) { // same waiter on both keys of a device counts once
      const id = k.leaseId || k.file;
      if (seen.has(id)) continue; seen.add(id); uniq.push(k);
    }
    const ctx = ticketCtx(t);
    const withState = uniq.map((tk) => ({ tk, dead: lease.ticketState(tk, ctx) === 'dead' }));
    const liveOnes = withState.filter((x) => !x.dead).map((x) => x.tk);
    const eta = lease.computeEta(holder, liveOnes, events, t);
    let pos = 0; let li = 0;
    const queue = withState.map(({ tk, dead }) => {
      const queuedAt = Date.parse(tk.queuedAt);
      const since = Number.isFinite(queuedAt) ? queuedAt : (/^(\d{1,15})-/.exec(tk.file || '') || [])[1] * 1;
      const row = {
        pos: dead ? null : ++pos, agent: tk.agent || null, purpose: tk.purpose || null,
        since: iso(since), waitingMs: Number.isFinite(since) ? Math.max(0, t - since) : null,
        etaMs: dead ? null : eta.perTicket[li++], dead,
      };
      return row;
    });
    return { queue, queueLength: liveOnes.length, etaMs: eta.etaMs };
  }

  function buildDevice(keys, hosts, live, labels, eventsOf, t, historyN, windowMs) {
    const events = eventsOf(keys);
    // holder: the first key that has one (identity key first)
    let rec = null; let holderKey = null; let reason = null; let corrupt = false;
    for (const k of keys) {
      const r = (live.get(k) || {}).rec;
      if (!r) continue;
      let why = null;
      try { why = store.staleReason(r); } catch { why = null; }
      if (!rec || (why && !reason)) { rec = r; holderKey = k; reason = why; }
      if (r.corrupt) corrupt = true;
    }
    const l = rec && rec.lease ? rec.lease : null;
    const tickets = keys.flatMap((k) => (live.get(k) || {}).tickets || []).sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    const q = buildQueue(tickets, l, events, t);

    let holder = null;
    if (l) {
      const h = l.holder || {};
      const acq = Date.parse(l.acquiredAt);
      holder = {
        agent: h.agent || null, purpose: h.purpose || null, mode: l.mode || null,
        since: iso(acq), heldMs: Number.isFinite(acq) ? Math.max(0, t - acq) : null,
        deadline: l.deadline || null, expiresAt: l.expiresAt || null, worktree: h.worktree || null, branch: h.branch || null,
        hostname: h.hostname || null, foreign: !!(h.hostname && h.hostname !== store.hostname), staleReason: reason,
        leaseId8: String(l.leaseId).slice(0, 8),
      };
    }
    const state = rec && rec.corrupt ? 'corrupt' : (reason ? 'stale' : (l ? 'held' : 'free'));
    const holderIds = new Set(keys.map((k) => { const r = (live.get(k) || {}).rec; return r && r.lease ? r.lease.leaseId : null; }).filter(Boolean));
    const runs = buildRuns(events, holderIds, t);
    const host = hosts[0] || null;
    let label = null;
    for (const k of keys) if (labels.get(k)) { label = labels.get(k); break; }
    if (!label) label = host || (ID_KEY.test(keys[0]) ? keys[0].slice(0, 7) + '…' : keys[0]);
    return {
      id: keys[0], label, hosts, keys, state: corrupt && state === 'held' ? 'corrupt' : state, holder,
      queue: q.queue, queueLength: q.queueLength, etaMs: q.etaMs,
      reach: { state: 'unknown', at: null },
      runs: runs.slice(-historyN).reverse(),
      stats: statsOf(runs, events, q, t, windowMs),
    };
  }

  // A run = `acquired` joined with its first later end event by leaseId. An acquired with no end event is
  // `running` when a holder file still carries that leaseId, else `unknown`. `timeout` events are rows too.
  function buildRuns(events, holderIds, t) {
    const acquired = new Map(); const order = [];
    const runs = [];
    for (const e of events) {
      if (!e.leaseId) continue;
      if (e.ev === 'acquired') {
        if (!acquired.has(e.leaseId)) { acquired.set(e.leaseId, { a: e, end: null }); order.push(e.leaseId); }
      } else if (END_EVENTS.has(e.ev)) {
        const r = acquired.get(e.leaseId);
        if (r && !r.end) r.end = e;
      } else if (e.ev === 'timeout') {
        const at = tsOf(e); const w = Number.isFinite(e.waitedMs) ? e.waitedMs : 0;
        runs.push({
          sort: at, row: {
            leaseId8: String(e.leaseId).slice(0, 8), agent: e.agent || null, purpose: e.purpose || null, mode: e.mode || null,
            startedAt: iso(at != null ? at - w : null), endedAt: iso(at), waitedMs: w, heldMs: null,
            ended: 'timeout', reason: e.reason || null, exitCode: null, hostname: e.hostname || null,
          },
        });
      }
    }
    for (const id of order) {
      const { a, end } = acquired.get(id);
      const at = tsOf(a);
      const endAt = end ? tsOf(end) : null;
      let heldMs = null;
      if (end) heldMs = Number.isFinite(end.heldMs) ? end.heldMs : (endAt != null && at != null ? Math.max(0, endAt - at) : null);
      else if (at != null) heldMs = Math.max(0, t - at);
      runs.push({
        sort: at, row: {
          leaseId8: String(id).slice(0, 8), agent: a.agent || null, purpose: a.purpose || null, mode: a.mode || null,
          startedAt: iso(at), endedAt: end ? iso(endAt) : null,
          waitedMs: Number.isFinite(a.waitedMs) ? a.waitedMs : null, heldMs,
          ended: end ? end.ev : (holderIds.has(id) ? 'running' : 'unknown'),
          reason: end ? (end.reason || null) : null,
          exitCode: end && Number.isFinite(end.exitCode) ? end.exitCode : null,
          hostname: a.hostname || null,
        },
      });
    }
    return runs.sort((x, y) => (x.sort || 0) - (y.sort || 0)).map((x) => x.row);
  }

  function statsOf(runs, events, q, t, windowMs) {
    const from = t - windowMs;
    const inWin = runs.filter((r) => { const s = Date.parse(r.endedAt || r.startedAt); return Number.isFinite(s) && s >= from; });
    const holds = inWin.filter((r) => r.ended !== 'timeout' && r.ended !== 'running' && r.ended !== 'unknown' && Number.isFinite(r.heldMs)).map((r) => r.heldMs).sort((a, b) => a - b);
    const waits = inWin.filter((r) => r.ended !== 'timeout' && Number.isFinite(r.waitedMs)).map((r) => r.waitedMs).sort((a, b) => a - b);
    // Longest line: sweep queued (+1) and acquired/timeout (-1) points inside the window; the line now counts too.
    const pts = [];
    const queuedIds = new Set();
    for (const e of events) {
      const at = tsOf(e);
      if (at == null || at < from || !e.leaseId) continue;
      if (e.ev === 'queued') { queuedIds.add(e.leaseId); pts.push([at, 1]); }
      else if ((e.ev === 'acquired' || e.ev === 'timeout') && queuedIds.has(e.leaseId)) pts.push([at, -1]);
    }
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0; let maxQ = 0;
    for (const [, d] of pts) { cur += d; if (cur > maxQ) maxQ = cur; }
    maxQ = Math.max(maxQ, q.queueLength);
    return {
      window: windowMs === DAY_MS ? '24h' : `${Math.round(windowMs / 60000)}m`,
      runs: inWin.filter((r) => r.ended !== 'timeout').length,
      medianHoldMs: percentile(holds, 0.5), p90HoldMs: percentile(holds, 0.9), medianWaitMs: percentile(waits, 0.5),
      maxQueue: maxQ, timeouts: inWin.filter((r) => r.ended === 'timeout').length,
    };
  }

  return { snapshot, close() { reader.forget(); }, dir: store.dir };
}

module.exports = { SCHEMA, createView, isLoopbackName };
