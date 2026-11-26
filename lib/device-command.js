'use strict';
const lease = require('./device-lease');
const identity = require('./device-identity');
const { resolveDevice, resolveEcpPort, cachedDevices } = require('./devices');

// `brighttest device status|with|unlock|log` — the CLI face of lib/device-lease.js, plus the helpers
// the device-touching lanes share (Home hygiene, the stderr waiting line).

const say = (s) => process.stderr.write(s.endsWith('\n') ? s : s + '\n');

// `--host ip[:pw][,…]` → the first host and its inline password (if any).
function splitHost(v) {
  if (!v) return { host: null, password: null };
  const first = String(v).split(',')[0].trim();
  const i = first.indexOf(':');
  if (i > 0 && first.indexOf(':', i + 1) === -1) return { host: first.slice(0, i), password: first.slice(i + 1) || null };
  return { host: first, password: null };
}

// Resolve the device for a lease command: flag (with inline ip:pw) → env / project .env → cache.
function resolveTarget(o) {
  const inline = splitHost(o.host);
  const r = resolveDevice({ host: inline.host, password: o.password || inline.password });
  return { host: r.host, password: r.password, ecpPort: resolveEcpPort(o.ecpPort) };
}

// Resolve host + password for a device lane (--device, --cross-check) through the same chain as
// resolveTarget (flag, with inline ip:pw → ROKU_HOST/ROKU_PASSWORD → cached device). Returns the opts with
// a bare host (no inline password) and the resolved password, or null when either is missing.
function resolveLaneOpts(opts) {
  const t = resolveTarget(opts);
  if (!t.host || !t.password) return null;
  return { ...opts, host: t.host, password: t.password };
}

// Rule: never silently pick the last cached device when more than one is known. Returns an error message
// when a lane has no explicit host, no env host and the cache holds several devices; otherwise null.
function ambiguousHostMessage(opts) {
  const r = resolveDevice({ host: splitHost(opts.host).host });
  if (r.source !== 'cache' || cachedDevices().length < 2) return null;
  return 'multiple devices are cached and no host was given: pass --host <ip> (or set ROKU_HOST) to choose one';
}

// `--device any` (opts.devicePool) with no explicit host: the configured pool, else null (the host wins).
function poolOf(cfg, opts) {
  if (!opts || !opts.devicePool || opts.host) return null;
  const raw = cfg && cfg.deviceLease ? cfg.deviceLease.pool : undefined;
  if (raw === undefined) return [];
  return require('./config').parseLeasePool(raw); // throws a clear Error on a bad value
}

// poolOf for a lane: { pool } or { code: 2 } after printing `[brighttest] <message>`.
function poolForLane(cfg, opts, say = (m) => console.error(`[brighttest] ${m}`)) {
  try { return { pool: poolOf(cfg, opts) }; } catch (e) { say(e.message); return { code: 2 }; }
}

// Before a pool pick: the pool must exist and every member must have a password (any may be chosen), so the lane
// fails fast (exit 2) without taking a lease. Returns an error message or null.
function poolPreflight(pool, opts, { needPassword = true } = {}) {
  if (!pool.length) return '--device any needs a device pool: set "deviceLease": { "pool": ["<ip>", "<ip>"] } in brighttest.json (or pass --host)';
  if (!needPassword) return null;
  for (const h of pool) {
    if (!resolveDevice({ host: h, password: opts.password }).password) {
      return `--device any: no dev password for pool device ${h}: pass --password, set ROKU_PASSWORD, or connect to it once (the device cache keeps it)`;
    }
  }
  return null;
}

// Best-effort Home ×2 (300 ms apart) then 1 s settle. Never fails the acquire; returns the error if any.
async function homeHygiene({ host, password, ecpPort }, { createDevice, sleep } = {}) {
  const make = createDevice || require('./e2e/ecp').createDevice;
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  try {
    const dev = make({ host, password, ecpPort });
    await dev.keypress('Home');
    await wait(300);
    await dev.keypress('Home');
    await wait(1000);
    return null;
  } catch (e) { return e; }
}

// Print the waiting line on stderr (at queue time and every 30 s).
function printWait(snap) { say(lease.formatWaitLine(snap, { waitUntil: snap.waitUntil })); }

function leaseErrorExit(e) {
  const code = lease.exitCodeFor(e);
  if (e && e.snapshot && (e.code === 'BUSY' || e.code === 'TIMEOUT')) say(lease.formatWaitLine(e.snapshot));
  say(e && e.message ? (e.message.startsWith('[brighttest lease]') ? e.message : `[brighttest lease] ${e.message}`) : String(e));
  return code;
}

// ---- lanes ------------------------------------------------------------------------------------
// Take the lease for a device-touching lane. Returns { lease } (lease null when bypassed with --no-lease,
// BRIGHTTEST_NO_LEASE=1 or deviceLease.enabled=false: loud warning + a `bypass` event) or { code } when the
// lease cannot be had (75 busy/timeout, 77 lost, 78 lease dir, 2 bad duration).
async function acquireForLane({ cfg, opts = {}, host, pool, ecpPort, password, purpose, command, hygiene = false, allowBypass = true, mode = 'command', env = process.env, deps = {} }) {
  const L = deps.lease || lease;
  let s;
  try { s = L.resolveSettings({ cfg, env, flags: { wait: opts.wait, max: opts.max, idle: opts.idle, expect: opts.expect, noHygiene: opts.noHygiene } }); }
  catch (e) { return { code: leaseErrorExit(e) }; }
  const secrets = [password].filter(Boolean);
  const usePool = !!(pool && pool.length) && !host; // an explicit host always wins over the pool
  if (usePool && (opts.noLease || env.BRIGHTTEST_NO_LEASE === '1' || !s.enabled)) host = pool[0];
  const bypass = !allowBypass ? null : opts.noLease ? '--no-lease' : env.BRIGHTTEST_NO_LEASE === '1' ? 'BRIGHTTEST_NO_LEASE=1' : !s.enabled ? 'deviceLease.enabled=false' : null;
  if (bypass) {
    say(`[brighttest lease] WARNING: running WITHOUT the device lease (${bypass}). Other processes may use ${host} at the same time.`);
    try {
      const store = L.createStore({ env });
      store.logEvent(await L.normalizeKey(host, { port: ecpPort }), {
        ev: 'bypass', agent: opts.as || env.BRIGHTTEST_AGENT || null, purpose: L.redactText(purpose || '', secrets), reason: bypass,
      });
    } catch { /* audit is best-effort */ }
    return usePool ? { lease: null, host } : { lease: null };
  }
  // One bounded device-info read for the lease key (per device, not per address). The lane then holds the
  // identity key AND the address key (see lease.acquire), so address-only holders still collide with it.
  let deviceId; let serial; let identityKey; let reuseKey = null; const keyNotes = [];
  if (!usePool && host) {
    // Single hold: a BRIGHTTEST_LEASE token that already holds this device is reused with no network read.
    const token = env.BRIGHTTEST_LEASE;
    if (token) {
      try {
        const store = L.createStore({ env });
        const held = store.findTokenKeys(token);
        const mine = [await L.normalizeKey(host, { port: ecpPort }), identity.recalledKey(L.defaultDir(env), host, ecpPort)];
        reuseKey = held.find((k) => mine.includes(k)) || null;
      } catch { /* no token store: read the identity as usual */ }
    }
  }
  if (!usePool && host && !reuseKey) {
    const got = await (deps.readIdentity || identity.readIdentity)(host, { port: ecpPort || 8060 });
    const where = `${L.stripHostPasswords(host)}${ecpPort && Number(ecpPort) !== 8060 ? `:${ecpPort}` : ''}`;
    if (got && got.id) {
      deviceId = got.id; serial = got.id;
      try { identity.rememberKey(L.defaultDir(env), host, L.keyFromIdentity(got.id), ecpPort); } catch { /* best-effort */ }
    } else {
      // The read failed (device busy, rebooting, unreachable): use the identity key remembered for this host so a
      // lane that holds the device by identity is still met; the address key is always taken too.
      const why = (got && got.reason) || 'unknown';
      try { identityKey = identity.recalledKey(L.defaultDir(env), host, ecpPort) || undefined; } catch { /* none */ }
      const msg = identityKey
        ? `device identity not read (${why}); leasing by remembered identity key ${identityKey} and address ${where}`
        : `device identity not read (${why}); leasing by address ${where}`;
      say(`[brighttest lease] ${msg}`);
      keyNotes.push(msg);
    }
  }
  let l;
  try {
    l = await (usePool ? (a) => L.acquirePool({ ...a, hosts: pool }) : L.acquire)({
      host, port: ecpPort, deviceId, identityKey, keyNotes, key: reuseKey || undefined, serial, agent: opts.as, purpose: opts.purpose || purpose, command, secrets, env,
      mode, waitMs: s.waitMs, maxHoldMs: mode === 'session' ? s.sessionMaxMs : s.maxHoldMs, idleMs: s.idleMs, expectMs: s.expectMs, onWait: deps.onWait || printWait,
    });
  } catch (e) { return { code: leaseErrorExit(e) }; }
  if (l.poolHost) { host = l.poolHost; say(`[brighttest lease] --device any: using ${host}`); }
  if (hygiene && !l.reentrant && s.hygiene === 'home') {
    const err = await (deps.homeHygiene || homeHygiene)({ host, password, ecpPort });
    if (err) {
      say(`[brighttest lease] warning: Home hygiene failed (${err.message}); continuing`);
      try { L.createStore({ env }).logEvent(l.key, { ev: 'hygiene-failed', leaseId: l.leaseId, reason: err.message }); } catch { /* best-effort */ }
    }
  }
  return usePool ? { lease: l, host } : { lease: l };
}

// ---- actions ----------------------------------------------------------------------------------

async function cmdWith(o, cfg, deps = {}) {
  if (!o.cmd.length) { say('[brighttest device] with: nothing to run (usage: brighttest device with [options] -- <cmd…>)'); return 2; }
  const KA = require('./device-keepalive');
  let kaSec = 0;
  if (o.keepalive != null) {
    const r = KA.parseKeepaliveSec(o.keepalive === true ? '' : o.keepalive);
    if (r.error) { say(`[brighttest device] ${r.error}`); return 2; }
    kaSec = r.sec;
  }
  const pf = poolForLane(cfg, o, (m) => say(`[brighttest device] ${m}`));
  if (pf.code != null) return pf.code;
  const pool = pf.pool;
  if (pool) { const bad = poolPreflight(pool, o, { needPassword: false }); if (bad) { say(`[brighttest device] ${bad}`); return 2; } }
  let t = pool ? { host: null, password: null, ecpPort: resolveEcpPort(o.ecpPort) } : resolveTarget(o);
  if (!t.host && !pool) { say('[brighttest device] no device host: pass --host or set ROKU_HOST'); return 2; }
  const got = await acquireForLane({
    cfg, opts: { ...o, purpose: o.purpose || `with ${require('path').basename(o.cmd[0])}` },
    command: ['brighttest', 'device', 'with', '--', ...o.cmd],
    host: t.host, pool: pool || undefined, ecpPort: t.ecpPort, password: t.password, hygiene: true, allowBypass: false,
    // `--lease <token>` runs under that (session) lease, like BRIGHTTEST_LEASE: re-entrant, no queueing.
    env: o.lease ? { ...process.env, BRIGHTTEST_LEASE: o.lease } : process.env,
  });
  if (got.code != null) return got.code;
  const l = got.lease;
  if (pool) t = { ...resolveTarget({ ...o, host: got.host }) };
  const env = { ...process.env, BRIGHTTEST_LEASE: l.leaseId, ROKU_HOST: t.host };
  if (t.password) env.ROKU_PASSWORD = t.password;
  if (o.ecpPort) env.ROKU_ECP_PORT = String(t.ecpPort);
  let stopKa = () => {};
  const onSig = () => stopKa();
  const endKa = () => { stopKa(); process.removeListener('SIGINT', onSig); process.removeListener('SIGTERM', onSig); };
  try {
    return await new Promise((resolve) => {
    let child;
    try { child = l.spawn(o.cmd[0], o.cmd.slice(1), { stdio: 'inherit', env }); }
    catch (e) { say(`[brighttest device] could not start ${o.cmd[0]}: ${e.message}`); l.release(undefined, { exitCode: 127 }); return resolve(127); }
    if (kaSec) {
      stopKa = (deps.keepalive || KA).start(t.host, KA.KEEPALIVE_KEY, kaSec, { password: t.password, ecpPort: t.ecpPort, log: say, createDevice: deps.createDevice });
      process.once('SIGINT', onSig); process.once('SIGTERM', onSig);
    }
    child.on('error', (e) => { endKa(); say(`[brighttest device] could not start ${o.cmd[0]}: ${e.message}`); l.release(undefined, { exitCode: 127 }); resolve(127); });
    child.on('close', (code, signal) => {
      endKa();
      const sigNo = signal ? (require('os').constants.signals[signal] || 0) : 0;
      const exitCode = code != null ? code : 128 + sigNo;
      l.release(undefined, { exitCode });
      resolve(exitCode);
    });
    });
  } finally { endKa(); }
}

function fmtTime(iso) { return iso ? new Date(iso).toTimeString().slice(0, 8) : '?'; }

function printStatusText(list) {
  if (!list.length) { console.log('no device leases (nothing held, nobody waiting)'); return; }
  for (const s of list) {
    if (!s.holder) console.log(`${s.key}: ${s.corrupt ? 'holder file unreadable' + (s.stale ? ' (stale)' : ' (being created)') : 'free'}`);
    else {
      const h = s.holder.holder || {};
      const held = lease.formatDuration(Date.now() - Date.parse(s.holder.acquiredAt));
      console.log(`${s.key}: held by ${h.agent} — "${h.purpose}"${s.stale ? `  [STALE: ${s.staleReason}]` : ''}`);
      console.log(`  mode ${s.holder.mode} · since ${fmtTime(s.holder.acquiredAt)} (${held}) · deadline ${fmtTime(s.holder.deadline)} · last seen ${fmtTime(s.holder.heartbeatAt)}`);
      const who = s.holder.mode === 'session' ? `session, no owner process${h.hostname ? ` (locked on ${h.hostname})` : ''}` : `pid ${h.pid}${h.hostname ? ` on ${h.hostname}` : ''}`;
      console.log(`  worktree ${h.worktree || '-'} (${h.branch || '-'}) · cwd ${h.cwd || '-'} · ${who}`);
      if (s.holder.mode === 'session') console.log(`  idle expiry ${fmtTime(s.holder.expiresAt)} (renewed by every use of the token)`);
      if (s.etaMs != null) console.log(`  est. free in ~${lease.formatDuration(s.etaMs)}`);
    }
    s.queue.forEach((t, i) => console.log(`  #${i + (s.holder ? 2 : 1)} ${t.agent} — "${t.purpose}" (waiting since ${fmtTime(t.queuedAt)})`));
  }
}

// Every lease key a host can be held under, no network: the identity key remembered for it (a lane that read
// the device identity holds that one) and its address key.
async function keysForHost(t, env = process.env) {
  const addr = await lease.normalizeKey(t.host, { port: t.ecpPort });
  const keys = [];
  try {
    const k = identity.recalledKey(lease.defaultDir(env), t.host, t.ecpPort);
    // The cache can be stale (a host re-addressed to another device): trust the remembered key only when its
    // holder was reached by this host, or the address key is held under the same lease (one two-key hold).
    if (k) {
      const store = lease.createStore({ env });
      const rec = store.readHolder(k);
      const l = rec && rec.lease;
      const bare = (h) => lease.stripHostPasswords(String(h || '')).trim().toLowerCase();
      const a = store.readHolder(addr);
      const sameHold = !!(l && a && a.lease && a.lease.leaseId === l.leaseId);
      const port = (p) => (p == null || p === '' ? 8060 : Number(p));
      // host AND port must match (the record carries the ECP port; an older record without one is not trusted)
      const sameAddr = !!(l && l.device && l.device.port != null && bare(l.device.host) === bare(t.host) && port(l.device.port) === port(t.ecpPort));
      if (!l || sameHold || sameAddr) keys.push(k);
    }
  } catch { /* none */ }
  keys.push(addr);
  return keys;
}

async function cmdStatus(o) {
  let keys = null;
  if (o.host) keys = await keysForHost(resolveTarget(o));
  let list;
  try { list = keys ? keys.flatMap((key) => lease.status({ key })) : lease.status({}); } catch (e) { return leaseErrorExit(e); }
  if (o.json) console.log(JSON.stringify(list, null, 2));
  else printStatusText(list);
  return 0;
}

async function cmdLog(o) {
  let evs;
  if (o.host) {
    const keys = await keysForHost(resolveTarget(o));
    const tail = o.tail || 20;
    evs = keys.flatMap((key) => lease.readEvents({ key, tail })).sort((a, b) => String(a.t).localeCompare(String(b.t))).slice(-tail);
  } else evs = lease.readEvents({ tail: o.tail || 20 });
  if (o.json) { console.log(JSON.stringify(evs, null, 2)); return 0; }
  if (!evs.length) { console.log('no lease events'); return 0; }
  for (const e of evs) {
    const extra = [e.waitedMs != null ? `waited ${lease.formatDuration(e.waitedMs)}` : '', e.heldMs != null ? `held ${lease.formatDuration(e.heldMs)}` : '', e.reason ? `reason: ${e.reason}` : '', e.by ? `by ${e.by}` : '']
      .filter(Boolean).join(' · ');
    console.log(`${e.t} ${e.key} ${e.ev.padEnd(9)} ${e.agent || '-'} "${e.purpose || ''}"${extra ? '  ' + extra : ''}`);
  }
  return 0;
}

// Read-only live board (lib/device-lease-view.js): never takes, changes or cleans a lease; its only network call is the bounded, cached reachability probe (off with --no-probe).
// `deps` lets tests inject the view, the io and the signal source.
async function cmdWatch(o, deps = {}) {
  const watch = require('./device-watch');
  let intervalMs = null;
  if (o.interval != null) {
    if (!String(o.interval).trim()) { say('[brighttest device] --interval needs a value (e.g. 2s or 500ms)'); return 2; }
    try { intervalMs = watch.parseInterval(o.interval); } catch (e) { say(`[brighttest device] ${e.message}`); return 2; }
  }
  const env = deps.env || process.env;
  let view;
  const prober = o.noProbe ? null : (deps.createProber || require('./device-lease-view').createProber)(deps.proberOpts || {});
  try { view = (deps.createView || require('./device-lease-view').createView)({ env, prober }); } catch (e) { if (prober) prober.stop(); return leaseErrorExit(e); }
  const flags = {
    host: o.host ? splitHost(o.host).host : undefined, once: !!o.once, json: !!o.json, plain: !!o.plain, all: !!o.all,
    noProbe: !!o.noProbe, tail: o.tail || 10, intervalMs: intervalMs || undefined,
  };
  const io = deps.io || {
    stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, stdoutIsTTY: !!process.stdout.isTTY, stdinIsTTY: !!process.stdin.isTTY,
    env, platform: process.platform, release: require('os').release(), getColorDepth: () => (process.stdout.getColorDepth ? process.stdout.getColorDepth() : 1),
  };
  const ac = new AbortController();
  const stop = () => ac.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    return await watch.runWatch({ view, flags, io, signal: ac.signal });
  } catch (e) { return leaseErrorExit(e); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); try { view.close(); } catch { /* best effort */ } }
}

async function cmdUnlock(o) {
  if (o.force) {
    const t = resolveTarget(o);
    if (!t.host) { say('[brighttest device] unlock --force needs --host (or ROKU_HOST)'); return 2; }
    const keys = await keysForHost(t);
    try {
      let failure = null;
      for (const key of keys.slice().reverse()) { // address key first, identity key last; one failing key must not skip the rest
        try {
          const r = lease.forceRelease({ key, reason: o.reason, kill: o.kill, by: o.as || process.env.BRIGHTTEST_AGENT });
          console.log(r.released ? `released ${key}${r.victim ? ` (lease ${r.victim.slice(0, 8)}…)` : ''}${o.kill ? ', holder killed' : ''}` : `${key} was not held`);
        } catch (e) { failure = failure || e; }
      }
      if (failure) return leaseErrorExit(failure);
      return 0;
    } catch (e) { return leaseErrorExit(e); }
  }
  const token = o.lease || process.env.BRIGHTTEST_LEASE;
  if (!token) { say('[brighttest device] unlock: give --lease <token> (or BRIGHTTEST_LEASE), or --force --reason "…" --host <h>'); return 2; }
  try {
    const r = lease.unlock(token);
    console.log(`unlocked ${r.key}`);
    return 0;
  } catch (e) { return leaseErrorExit(e); }
}

// `device lock`: take a session lease and print its token. The token is the only thing needed afterwards:
// pass it as `BRIGHTTEST_LEASE=<token>` (or `--lease`) on each command, `renew` it, `unlock` it. It expires
// after --idle without use (default 10m) and always at --max (default 45m).
async function cmdLock(o, cfg) {
  const t = resolveTarget(o);
  if (!t.host) { say('[brighttest device] no device host: pass --host or set ROKU_HOST'); return 2; }
  const env = { ...process.env };
  const have = env.BRIGHTTEST_LEASE;
  if (have) {
    // Holding a live session on this very device already: say so instead of queueing behind ourselves.
    try {
      const store = lease.createStore({ env });
      const keys = await keysForHost(t, env);
      const key = store.findTokenKeys(have).find((k) => keys.includes(k));
      if (key && lease.tokenValid(have, { store })) {
        say(`[brighttest lease] BRIGHTTEST_LEASE already holds ${key}; use \`device renew\` or \`device unlock\` first`);
        return 2;
      }
    } catch { /* fall through: a stale token in the env must not block a new lock */ }
    delete env.BRIGHTTEST_LEASE;
  }
  const got = await acquireForLane({
    cfg, opts: { ...o, purpose: o.purpose || 'session' },
    command: ['brighttest', 'device', 'lock'],
    host: t.host, ecpPort: t.ecpPort, password: t.password, hygiene: true, allowBypass: false, mode: 'session', env,
  });
  if (got.code != null) return got.code;
  const rec = got.lease.record;
  if (o.json) console.log(JSON.stringify({ leaseId: rec.leaseId, deadline: rec.deadline, expiresAt: rec.expiresAt }));
  else {
    console.log(rec.leaseId);
    say(`[brighttest lease] locked ${got.lease.key} for ${rec.holder.agent}: expires ${fmtTime(rec.expiresAt)} without use (renewed by every use), hard cap ${fmtTime(rec.deadline)}.\n` +
      '  Use it as: BRIGHTTEST_LEASE=<token> brighttest device with -- <cmd> (or raw commands the hook allows). Then: brighttest device unlock --lease <token>');
  }
  return 0;
}

async function cmdRenew(o) {
  const token = o.lease || process.env.BRIGHTTEST_LEASE;
  if (!token) { say('[brighttest device] renew: give --lease <token> (or BRIGHTTEST_LEASE)'); return 2; }
  try {
    const r = lease.renew(token);
    if (o.json) console.log(JSON.stringify({ leaseId: r.leaseId, deadline: r.deadline, expiresAt: r.expiresAt }));
    else console.log(`renewed ${r.key}: expires ${fmtTime(r.expiresAt)} without use, hard cap ${fmtTime(r.deadline)}`);
    return 0;
  } catch (e) { return leaseErrorExit(e); }
}

async function run(o, cfg, deps = {}) {
  if (o.devicePool && o.deviceAction !== 'with') {
    say(`[brighttest device] --device any applies to "device with" only (not "${o.deviceAction || ''}")`);
    return 2;
  }
  switch (o.deviceAction) {
    case 'with': return cmdWith(o, cfg, deps);
    case 'status': return cmdStatus(o);
    case 'log': return cmdLog(o);
    case 'watch': return cmdWatch(o, deps);
    case 'unlock': return cmdUnlock(o);
    case 'lock': return cmdLock(o, cfg);
    case 'renew': return cmdRenew(o);
    default:
      say(`[brighttest device] "${o.deviceAction}" is not available yet (status, with, lock, renew, unlock, log, watch are)`);
      return 2;
  }
}

module.exports = { cmdWatch, poolOf, poolForLane, poolPreflight, run, splitHost, resolveTarget, resolveLaneOpts, ambiguousHostMessage, homeHygiene, printWait, leaseErrorExit, acquireForLane };
