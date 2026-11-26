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
// (readHolder, readTickets, staleReason, listKeys), plain reads of identity-cache.json, and its own event
// reader, which opens, reads and closes a file each time so it can never block the lease's log rotation (a
// rename) on Windows. staleReason may run `ps` for a live local holder (cached for 2 s); that is the only
// process the view can start, so a caller must not hold a lease while it asks for a board.
//
// Every string and number taken from a lease file is coerced to a bounded string or a finite number before it
// goes into the board. Terminal escape sequences are NOT removed here: the renderers sanitize what they print.

const SCHEMA = 'brighttest-lease-board/v1';
const DAY_MS = 24 * 3600 * 1000;
const IDLE_HIDE_MS = 7 * DAY_MS;
// A device is probed only when it is held or queued, configured (devices.json, deviceLease.pool, ROKU_HOST, --host) or
// was held/finished within this window. A device that exists only as older lease history is listed, not probed.
const PROBE_RECENT_MS = DAY_MS;

// Pure selection: should the board probe this device? `newest` is the newest holder/event time (ms) or 0.
function shouldProbe({ held, configured, newest, now, noProbe }) {
  if (noProbe) return false;
  if (held || configured) return true;
  return Number.isFinite(newest) && newest > 0 && now - newest <= PROBE_RECENT_MS;
}
const END_EVENTS = new Set(['released', 'lost', 'reclaimed', 'forced']);
const POOL_KEY = /^pool-[0-9a-f]{12}$/;
const ID_KEY = /^id-[0-9a-f]{16}$/;

// ---- small helpers ----------------------------------------------------------------------------
// Loopback address keys: 127.x.x.x, localhost, and ::1 (as keyFromAddress writes it, with ':' as '_').
function isLoopbackName(name) {
  const n = String(name || '').toLowerCase().replace(/_p\d+$/, '');
  return /^127\./.test(n) || n === 'localhost' || n === '__1' || n === '0_0_0_0_0_0_0_1' || n === '::1'
    || /^(__ffff_|::ffff:)127\./.test(n);
}
// Values from lease files: a bounded string (numbers and booleans are stringified, objects are dropped).
function str(v, max = 300) {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
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

// ---- bounded cached reachability probe (design D5) --------------------------------------------
// createProber({ intervalMs = 30000, timeoutMs = 1000, fetchImpl, now })
//   want(hosts[])  mark the hosts the board shows; a probe starts for each one whose last probe is older than
//                  intervalMs (all in parallel, in the background, at most one GET /query/device-info per device
//                  per interval). A host is "host" or "host:port" (default ECP port 8060).
//   get(host)      -> { state: 'up' | 'unreachable' | 'unknown', at (ms), identityKey?, error? }
//   settle()       -> Promise that resolves when the probes in flight are done (for --once and --json)
//   stop()         clears timers and aborts requests in flight
// A probe takes no lease, writes nothing and never throws; the only request is the bounded GET.
function createProber(o = {}) {
  const intervalMs = o.intervalMs != null ? o.intervalMs : 30000;
  const timeoutMs = o.timeoutMs != null ? o.timeoutMs : 1000;
  const fetchImpl = o.fetchImpl || globalThis.fetch;
  const now = o.now || (() => Date.now());
  const state = new Map();   // host -> { startedAt, result }
  const inflight = new Map(); // host -> { promise, ac, timer }
  let stopped = false;

  function target(h) {
    const m = /^(.*):(\d{1,5})$/.exec(h);
    const host = m && !m[1].includes(':') ? m[1] : h;
    const port = m && !m[1].includes(':') ? m[2] : 8060;
    return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}/query/device-info`;
  }
  async function run(h, ac) {
    try {
      const res = await fetchImpl(target(h), { signal: ac.signal });
      if (!res.ok) return { state: 'unreachable', error: `device-info HTTP ${res.status}` };
      const xml = await res.text();
      const tag = (n) => { const m = new RegExp(`<${n}(?:\\s[^>]*)?>([^<]*)</${n}>`, 'i').exec(xml); return m && m[1].trim() ? m[1].trim() : null; };
      const id = tag('serial-number') || tag('device-id');
      return { state: 'up', ...(id ? { identityKey: lease.keyFromIdentity(id) } : {}) };
    } catch (e) {
      return { state: 'unreachable', error: ac.signal.aborted ? `device-info timed out after ${timeoutMs} ms` : 'device-info unreachable' };
    }
  }
  function start(h) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    if (timer.unref) timer.unref();
    const entry = { startedAt: now(), result: (state.get(h) || {}).result || null };
    state.set(h, entry);
    // a hung fetchImpl that ignores the signal still ends at the bound
    const bound = new Promise((resolve) => { ac.signal.addEventListener('abort', () => resolve({ state: 'unreachable', error: stopped ? 'stopped' : `device-info timed out after ${timeoutMs} ms` }), { once: true }); });
    const promise = Promise.race([run(h, ac), bound]).then((r) => {
      clearTimeout(timer); inflight.delete(h);
      if (!stopped) entry.result = { ...r, at: now() };
    });
    inflight.set(h, { promise, ac, timer });
  }
  return {
    want(hosts) {
      if (stopped) return;
      const t = now();
      for (const h of new Set((hosts || []).filter(Boolean).map(String))) {
        if (inflight.has(h)) continue;
        const e = state.get(h);
        if (!e || t - e.startedAt >= intervalMs) start(h);
      }
    },
    get(h) {
      const e = state.get(String(h));
      return e && e.result ? { ...e.result } : { state: 'unknown', at: null };
    },
    settle() { return Promise.all([...inflight.values()].map((x) => x.promise)).then(() => undefined); },
    stop() {
      stopped = true;
      for (const { ac, timer } of inflight.values()) { clearTimeout(timer); try { ac.abort(); } catch { /* ignore */ } }
      inflight.clear();
    },
  };
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
  const prober = o.prober || null;
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
      const host = str(lease.stripHostPasswords(String(d.host)).trim(), 200);
      if (!host) continue;
      const ak = addrKeyOf(host);
      add(ak); addHost(ak, host); knownKeys.add(ak);
      if (str(d.name, 100)) labels.set(ak, str(d.name, 100));
    }
    const configuredKeys = new Set();
    for (const d of known()) {
      if (!d || !d.host) continue;
      const h = str(lease.stripHostPasswords(String(d.host)).trim(), 200);
      if (h) configuredKeys.add(addrKeyOf(h));
    }
    const poolHosts = (o.cfg && o.cfg.deviceLease && Array.isArray(o.cfg.deviceLease.pool)) ? o.cfg.deviceLease.pool : [];
    for (const h of [...poolHosts, env.ROKU_HOST].filter(Boolean)) {
      const host = lease.stripHostPasswords(String(h)).trim();
      const ak = addrKeyOf(host);
      add(ak); addHost(ak, host); knownKeys.add(ak); configuredKeys.add(ak);
    }

    // 2. Live state per key (read-only): holder, tickets, stale reason, newest file time. The events.log stat is
    // skipped for loopback-named keys (they are hidden unless held, and their age never matters).
    const live = new Map();
    const poolRows = [];
    let transient = null;
    const fail = (e) => { transient = transient || str(String(e && e.message || e).split(store.dir).join(shortDir(store.dir)), 200); };
    const ctx0 = ticketCtx(t);
    for (const k of dirKeys) {
      let rec = null; let tickets = [];
      try { rec = store.readHolder(k); } catch (e) { fail(e); }
      try { tickets = store.readTickets(k); } catch (e) { fail(e); }
      let stale = null;
      if (rec) { try { stale = store.staleReason(rec); } catch { stale = null; } }
      const liveTickets = tickets.filter((tk) => lease.ticketState(tk, ctx0) !== 'dead').length;
      let lastEvent = rec && Number.isFinite(rec.mtimeMs) ? rec.mtimeMs : null;
      if (!isLoopbackName(k)) {
        for (const f of ['events.log', 'events.log.1']) {
          try { const st = io.statSync(path.join(store.dir, k, f)); lastEvent = Math.max(lastEvent || 0, st.mtimeMs); } catch { /* none */ }
        }
      }
      live.set(k, { rec, tickets, stale, liveTickets, lastEvent });
      if (rec && rec.lease && rec.lease.device) {
        const d = rec.lease.device;
        const dh = str(d.host);
        if (dh && !ID_KEY.test(dh) && dh !== k) {
          const ak = addrKeyOf(dh, num(d.port) == null ? undefined : d.port);
          union(k, ak); addHost(k, dh); addHost(ak, dh);
        } else if (dh && dh === k && !ID_KEY.test(k)) addHost(k, dh);
      }
    }
    for (const k of dirKeys) { if (!ID_KEY.test(k) && !POOL_KEY.test(k) && !hostsOf.has(k)) addHost(k, hostOfKey(k)); }

    // Two keys whose `acquired` events share a lease id are one device (a lane that holds the identity key and the
    // address key writes the same lease id to both). This also joins a device reached by host name, whose
    // identity-cache name is not the resolved address the lane wrote. Only keys that could be shown are read.
    const byLease = new Map();
    for (const k of dirKeys) {
      if (POOL_KEY.test(k) || isLoopbackName(k)) continue;
      const l = live.get(k);
      if (!knownKeys.has(k) && !(l.rec || l.liveTickets) && (!l.lastEvent || t - l.lastEvent > IDLE_HIDE_MS)) continue;
      for (const e of reader.read(path.join(store.dir, k, 'events.log'))) {
        if (e.ev !== 'acquired' || !e.leaseId) continue;
        const id = String(e.leaseId);
        if (byLease.has(id) && byLease.get(id) !== k) union(byLease.get(id), k); else byLease.set(id, k);
      }
    }

    // 3. Group keys into devices.
    const groups = new Map(); // root -> [keys]
    for (const k of parent.keys()) {
      if (POOL_KEY.test(k)) continue;
      const r = find(k);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(k);
    }
    // Busy = a holder that is not stale, or a ticket that is not dead. Leftovers (stale holders, dead tickets) are
    // not busy: a crashed test's loopback key must not keep showing.
    const busy = (keys) => keys.some((k) => { const l = live.get(k); return l && ((l.rec && !l.stale) || l.liveTickets > 0); });

    const devices = [];
    const probeTargets = [];
    let hiddenKeys = 0;
    let staleLoopbackHolders = 0;
    const logOf = (k) => reader.read(path.join(store.dir, k, 'events.log'));
    // All events of a device's keys, one copy per (event, lease id), ordered by time. Used for the ETA and the
    // line-length stats, which do not care about pairing. Runs are paired per key in file order (see buildRuns).
    const eventsOf = (keys) => {
      const seen = new Set(); const out = [];
      for (const k of keys) {
        for (const e of logOf(k)) {
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
      const heldNow = busy(keys);
      const hosts = [...new Set(keys.flatMap((k) => [...(hostsOf.get(k) || [])]))].filter(Boolean);
      const loop = hosts.length ? hosts.every(isLoopbackName) : keys.every(isLoopbackName);
      const newest = Math.max(0, ...keys.map((k) => (live.get(k) || {}).lastEvent || 0));
      const hasStale = keys.some((k) => (live.get(k) || {}).stale);
      const isKnown = keys.some((k) => knownKeys.has(k));
      const wanted = opts.host && (hosts.some((h) => h.toLowerCase() === String(opts.host).toLowerCase()) || keys.includes(opts.host));
      let show = true;
      if (opts.host) show = !!wanted;
      else if (!opts.all && !heldNow) {
        if (loop) show = false;
        else if (!isKnown && (!newest || t - newest > IDLE_HIDE_MS)) show = false;
      }
      if (!show) {
        hiddenKeys += keys.filter((k) => dirSet.has(k)).length;
        if (hasStale && loop) staleLoopbackHolders++;
        continue;
      }
      const dev = buildDevice(keys, hosts, live, labels, eventsOf, logOf, t, historyN, windowMs);
      devices.push(dev);
      if (prober) {
        const configured = !!wanted || keys.some((k) => configuredKeys.has(k));
        if (shouldProbe({ held: heldNow, configured, newest, now: t })) probeTargets.push({ dev, target: probeTargetOf(dev, keys, live) });
        else dev.reach = { state: 'unknown', at: null, idle: true };
      }
    }
    if (prober) {
      try { prober.want(probeTargets.map((x) => x.target).filter(Boolean)); } catch { /* never fails the board */ }
      const ids = identityMap();
      for (const { dev, target } of probeTargets) if (target) dev.reach = reachOf(target, ids);
    }
    devices.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

    // 4. Pool gate rows (never devices, never in history).
    for (const k of dirKeys.filter((x) => POOL_KEY.test(x))) {
      const l = live.get(k);
      if (!l.rec && !l.liveTickets) continue;
      const events = eventsOf([k]);
      const q = buildQueue(l.tickets, l.rec && l.rec.lease ? l.rec.lease : null, events, t);
      poolRows.push({ size: poolHosts.length || null, queueLength: q.queueLength, queue: q.queue });
    }

    return {
      schema: SCHEMA, at: iso(t), dir: shortDir(store.dir), machine, devices, pools: poolRows,
      hidden: { keys: hiddenKeys, staleLoopbackHolders, why: 'loopback or idle > 7d; --all to show' },
      ...(transient ? { error: transient } : {}),
    };
  }

  // The address the probe asks: the device's first host, plus the ECP port when a holder record says it is not 8060.
  function probeTargetOf(dev, keys, live) {
    const host = dev.hosts[0];
    if (!host) return null;
    for (const k of keys) {
      const r = (live.get(k) || {}).rec;
      const d = r && r.lease && r.lease.device;
      const p = d ? num(d.port) : null;
      if (p != null && p !== 8060 && str(d.host) === host) return `${host}:${p}`;
    }
    return host;
  }
  function reachOf(target, ids) {
    let r;
    try { r = prober.get(target); } catch { r = null; }
    if (!r || (r.state !== 'up' && r.state !== 'unreachable')) return { state: 'unknown', at: null };
    const out = { state: r.state, at: iso(r.at) };
    if (r.error) out.error = r.error;
    if (r.state === 'up' && r.identityKey) {
      const m = /^(.*):(\d{1,5})$/.exec(target);
      const host = (m && !m[1].includes(':') ? m[1] : target).toLowerCase();
      const port = m && !m[1].includes(':') ? Number(m[2]) : 8060;
      const name = host + (port !== 8060 ? `_p${port}` : '');
      const known = ids.filter((x) => x.name === name);
      if (known.length && !known.some((x) => x.key === r.identityKey)) out.note = 'address now points at a different device';
    }
    return out;
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
      return {
        pos: dead ? null : ++pos, agent: str(tk.agent), purpose: str(tk.purpose),
        since: iso(since), waitingMs: Number.isFinite(since) ? Math.max(0, t - since) : null,
        etaMs: dead ? null : eta.perTicket[li++], dead,
      };
    });
    return { queue, queueLength: liveOnes.length, etaMs: eta.etaMs };
  }

  function buildDevice(keys, hosts, live, labels, eventsOf, logOf, t, historyN, windowMs) {
    const events = eventsOf(keys);
    // Holder choice: a valid holder file beats a corrupt one (the other key's good record is the truth); among
    // valid ones a stale one is preferred so the problem shows; otherwise the first key (identity key first).
    let rec = null; let reason = null; let corruptKey = null;
    for (const k of keys) {
      const lv = live.get(k) || {};
      const r = lv.rec;
      if (!r) continue;
      if (r.corrupt) { corruptKey = corruptKey || k; if (!rec) { rec = r; reason = lv.stale; } continue; }
      if (!rec || rec.corrupt || (lv.stale && !reason)) { rec = r; reason = lv.stale; }
    }
    const l = rec && rec.lease ? rec.lease : null;
    const tickets = keys.flatMap((k) => (live.get(k) || {}).tickets || []).sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    const q = buildQueue(tickets, l, events, t);

    let holder = null;
    if (l) {
      const h = l.holder && typeof l.holder === 'object' ? l.holder : {};
      const acq = Date.parse(l.acquiredAt);
      const hn = str(h.hostname);
      const wt = str(h.worktree);
      holder = {
        agent: str(h.agent), purpose: str(h.purpose), mode: str(l.mode, 20),
        since: iso(acq), heldMs: Number.isFinite(acq) ? Math.max(0, t - acq) : null,
        deadline: str(l.deadline, 40), expiresAt: str(l.expiresAt, 40), worktree: wt ? shortDir(wt) : null, branch: str(h.branch),
        hostname: hn, foreign: !!(hn && hn !== store.hostname), staleReason: reason,
        leaseId8: String(l.leaseId).slice(0, 8),
      };
    }
    const state = rec && rec.corrupt ? 'corrupt' : (reason ? 'stale' : (l ? 'held' : 'free'));
    const holderIds = new Set(keys.map((k) => { const r = (live.get(k) || {}).rec; return r && r.lease ? String(r.lease.leaseId) : null; }).filter(Boolean));
    const runs = buildRuns(keys, logOf, holderIds, t);
    let label = null;
    for (const k of keys) if (labels.get(k)) { label = labels.get(k); break; }
    if (!label) label = hosts[0] || (ID_KEY.test(keys[0]) ? keys[0].slice(0, 7) + '…' : keys[0]);
    const dev = {
      id: keys[0], label, hosts, keys, state, holder,
      queue: q.queue, queueLength: q.queueLength, etaMs: q.etaMs,
      reach: { state: 'unknown', at: null },
      runs: runs.slice(-historyN).reverse(),
      stats: statsOf(runs, events, q, t, windowMs),
    };
    if (corruptKey) dev.error = `holder file on ${corruptKey} is unreadable`;
    return dev;
  }

  // A run = `acquired` joined with its first later end event by leaseId. Each key's log is paired in file order
  // (a clock that stepped back does not break the pairing); then the per-key halves of one lease id are merged.
  // A lane that holds two keys logs the lease on both, one leg after the other. The merged run takes its hold
  // from the leg that was acquired last (both keys held) and its wait from the EARLIEST waiting start of any
  // leg (acquired time minus waitedMs), so the identity-key wait plus the address-key wait is the real wait.
  // An acquired with no end event is `running` when a holder file still carries that lease id, else `unknown`.
  // `timeout` events are rows too.
  function buildRuns(keys, logOf, holderIds, t) {
    const merged = new Map(); // leaseId -> { legs: [{ at, waitStart, row }] }
    const out = [];
    const seenTimeout = new Set();
    for (const k of keys) {
      const acquired = new Map(); const order = [];
      for (const e of logOf(k)) {
        if (!e.leaseId) continue;
        const id = String(e.leaseId);
        if (e.ev === 'acquired') {
          if (!acquired.has(id)) { acquired.set(id, { a: e, end: null }); order.push(id); }
        } else if (END_EVENTS.has(e.ev)) {
          const r = acquired.get(id);
          if (r && !r.end) r.end = e;
        } else if (e.ev === 'timeout') {
          if (seenTimeout.has(id)) continue;
          seenTimeout.add(id);
          const at = tsOf(e); const w = num(e.waitedMs) == null ? 0 : e.waitedMs;
          out.push({
            sort: at, row: {
              leaseId8: id.slice(0, 8), agent: str(e.agent), purpose: str(e.purpose), mode: str(e.mode, 20),
              startedAt: iso(at != null ? at - w : null), endedAt: iso(at), waitedMs: w, heldMs: null,
              ended: 'timeout', reason: str(e.reason), exitCode: null, hostname: str(e.hostname),
            },
          });
        }
      }
      for (const id of order) {
        const { a, end } = acquired.get(id);
        const at = tsOf(a);
        const endAt = end ? tsOf(end) : null;
        const waited = num(a.waitedMs);
        let heldMs = null;
        if (end) heldMs = num(end.heldMs) != null ? end.heldMs : (endAt != null && at != null ? Math.max(0, endAt - at) : null);
        else if (at != null) heldMs = Math.max(0, t - at);
        const leg = {
          at, waitStart: at != null && waited != null ? at - waited : null,
          row: {
            leaseId8: id.slice(0, 8), agent: str(a.agent), purpose: str(a.purpose), mode: str(a.mode, 20),
            startedAt: iso(at), endedAt: end ? iso(endAt) : null, waitedMs: waited, heldMs,
            ended: end ? end.ev : (holderIds.has(id) ? 'running' : 'unknown'),
            reason: end ? str(end.reason) : null, exitCode: end ? num(end.exitCode) : null, hostname: str(a.hostname), queuedAhead: num(a.queuedAhead),
          },
        };
        if (!merged.has(id)) merged.set(id, []);
        merged.get(id).push(leg);
      }
    }
    for (const legs of merged.values()) {
      const hold = legs.reduce((best, g) => ((g.at || 0) > (best.at || 0) ? g : best), legs[0]);
      const row = { ...hold.row };
      const aheads = legs.map((g) => g.row.queuedAhead).filter((x) => x != null);
      if (aheads.length) row.queuedAhead = Math.max(...aheads); // the leg that queued saw the line; the last leg saw none
      const starts = legs.map((g) => g.waitStart).filter((x) => x != null);
      if (starts.length && hold.at != null) row.waitedMs = Math.max(0, hold.at - Math.min(...starts));
      out.push({ sort: hold.at, row });
    }
    return out.sort((x, y) => (x.sort || 0) - (y.sort || 0)).map((x) => x.row);
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

  return {
    snapshot,
    // Resolves when the probes started by the last snapshot are done (bounded by the probe timeout).
    settle() { return prober && prober.settle ? prober.settle() : Promise.resolve(); },
    close() { reader.forget(); if (prober) { try { prober.stop(); } catch { /* ignore */ } } },
    dir: store.dir,
  };
}

module.exports = { SCHEMA, PROBE_RECENT_MS, shouldProbe, createView, createProber, isLoopbackName };
