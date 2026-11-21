'use strict';
const lease = require('./device-lease');
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
async function acquireForLane({ cfg, opts = {}, host, ecpPort, password, purpose, command, hygiene = false, allowBypass = true, env = process.env, deps = {} }) {
  const L = deps.lease || lease;
  let s;
  try { s = L.resolveSettings({ cfg, env, flags: { wait: opts.wait, max: opts.max, expect: opts.expect, noHygiene: opts.noHygiene } }); }
  catch (e) { return { code: leaseErrorExit(e) }; }
  const secrets = [password].filter(Boolean);
  const bypass = !allowBypass ? null : opts.noLease ? '--no-lease' : env.BRIGHTTEST_NO_LEASE === '1' ? 'BRIGHTTEST_NO_LEASE=1' : !s.enabled ? 'deviceLease.enabled=false' : null;
  if (bypass) {
    say(`[brighttest lease] WARNING: running WITHOUT the device lease (${bypass}). Other processes may use ${host} at the same time.`);
    try {
      const store = L.createStore({ env });
      store.logEvent(await L.normalizeKey(host, { port: ecpPort }), {
        ev: 'bypass', agent: opts.as || env.BRIGHTTEST_AGENT || null, purpose: L.redactText(purpose || '', secrets), reason: bypass,
      });
    } catch { /* audit is best-effort */ }
    return { lease: null };
  }
  let l;
  try {
    l = await L.acquire({
      host, port: ecpPort, agent: opts.as, purpose: opts.purpose || purpose, command, secrets, env,
      waitMs: s.waitMs, maxHoldMs: s.maxHoldMs, expectMs: s.expectMs, onWait: deps.onWait || printWait,
    });
  } catch (e) { return { code: leaseErrorExit(e) }; }
  if (hygiene && !l.reentrant && s.hygiene === 'home') {
    const err = await (deps.homeHygiene || homeHygiene)({ host, password, ecpPort });
    if (err) {
      say(`[brighttest lease] warning: Home hygiene failed (${err.message}); continuing`);
      try { L.createStore({ env }).logEvent(l.key, { ev: 'hygiene-failed', leaseId: l.leaseId, reason: err.message }); } catch { /* best-effort */ }
    }
  }
  return { lease: l };
}

// ---- actions ----------------------------------------------------------------------------------

async function cmdWith(o, cfg) {
  if (!o.cmd.length) { say('[brighttest device] with: nothing to run (usage: brighttest device with [options] -- <cmd…>)'); return 2; }
  const t = resolveTarget(o);
  if (!t.host) { say('[brighttest device] no device host: pass --host or set ROKU_HOST'); return 2; }
  const got = await acquireForLane({
    cfg, opts: { ...o, purpose: o.purpose || `with ${require('path').basename(o.cmd[0])}` },
    command: ['brighttest', 'device', 'with', '--', ...o.cmd],
    host: t.host, ecpPort: t.ecpPort, password: t.password, hygiene: true, allowBypass: false,
  });
  if (got.code != null) return got.code;
  const l = got.lease;
  const env = { ...process.env, BRIGHTTEST_LEASE: l.leaseId, ROKU_HOST: t.host };
  if (t.password) env.ROKU_PASSWORD = t.password;
  if (o.ecpPort) env.ROKU_ECP_PORT = String(t.ecpPort);
  return new Promise((resolve) => {
    let child;
    try { child = l.spawn(o.cmd[0], o.cmd.slice(1), { stdio: 'inherit', env }); }
    catch (e) { say(`[brighttest device] could not start ${o.cmd[0]}: ${e.message}`); l.release(); return resolve(127); }
    child.on('error', (e) => { say(`[brighttest device] could not start ${o.cmd[0]}: ${e.message}`); l.release(); resolve(127); });
    child.on('close', (code, signal) => {
      l.release();
      const sigNo = signal ? (require('os').constants.signals[signal] || 0) : 0;
      resolve(code != null ? code : 128 + sigNo);
    });
  });
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
      console.log(`  worktree ${h.worktree || '-'} (${h.branch || '-'}) · cwd ${h.cwd || '-'} · pid ${h.pid}${h.hostname ? ` on ${h.hostname}` : ''}`);
      if (s.etaMs != null) console.log(`  est. free in ~${lease.formatDuration(s.etaMs)}`);
    }
    s.queue.forEach((t, i) => console.log(`  #${i + (s.holder ? 2 : 1)} ${t.agent} — "${t.purpose}" (waiting since ${fmtTime(t.queuedAt)})`));
  }
}

async function cmdStatus(o) {
  let key;
  if (o.host) {
    const t = resolveTarget(o);
    key = await lease.normalizeKey(t.host, { port: t.ecpPort });
  }
  let list;
  try { list = lease.status({ key }); } catch (e) { return leaseErrorExit(e); }
  if (o.json) console.log(JSON.stringify(list, null, 2));
  else printStatusText(list);
  return 0;
}

async function cmdLog(o) {
  let key;
  if (o.host) { const t = resolveTarget(o); key = await lease.normalizeKey(t.host, { port: t.ecpPort }); }
  const evs = lease.readEvents({ key, tail: o.tail || 20 });
  if (o.json) { console.log(JSON.stringify(evs, null, 2)); return 0; }
  if (!evs.length) { console.log('no lease events'); return 0; }
  for (const e of evs) {
    const extra = [e.waitedMs != null ? `waited ${lease.formatDuration(e.waitedMs)}` : '', e.heldMs != null ? `held ${lease.formatDuration(e.heldMs)}` : '', e.reason ? `reason: ${e.reason}` : '', e.by ? `by ${e.by}` : '']
      .filter(Boolean).join(' · ');
    console.log(`${e.t} ${e.key} ${e.ev.padEnd(9)} ${e.agent || '-'} "${e.purpose || ''}"${extra ? '  ' + extra : ''}`);
  }
  return 0;
}

async function cmdUnlock(o) {
  if (o.force) {
    const t = resolveTarget(o);
    if (!t.host) { say('[brighttest device] unlock --force needs --host (or ROKU_HOST)'); return 2; }
    const key = await lease.normalizeKey(t.host, { port: t.ecpPort });
    try {
      const r = lease.forceRelease({ key, reason: o.reason, kill: o.kill, by: o.as || process.env.BRIGHTTEST_AGENT });
      console.log(r.released ? `released ${key}${r.victim ? ` (lease ${r.victim.slice(0, 8)}…)` : ''}${o.kill ? ', holder killed' : ''}` : `${key} was not held`);
      return 0;
    } catch (e) { return leaseErrorExit(e); }
  }
  const token = o.lease || process.env.BRIGHTTEST_LEASE;
  if (!token) { say('[brighttest device] unlock: give --lease <token> (or BRIGHTTEST_LEASE), or --force --reason "…" --host <h>'); return 2; }
  const store = lease.createStore();
  const key = store.findToken(token);
  if (!key) { say(`[brighttest lease] lease ${token.slice(0, 8)}… is not held`); return 77; }
  const rec = store.readHolder(key).lease;
  say(`[brighttest lease] lease ${token.slice(0, 8)}… on ${key} is a ${rec.mode} lease held by pid ${rec.holder.pid}; ` +
    'it is released when its command ends (session leases arrive with `device lock`). Use --force --reason "…" to override.');
  return 2;
}

async function run(o, cfg) {
  switch (o.deviceAction) {
    case 'with': return cmdWith(o, cfg);
    case 'status': return cmdStatus(o);
    case 'log': return cmdLog(o);
    case 'unlock': return cmdUnlock(o);
    default:
      say(`[brighttest device] "${o.deviceAction}" is not available yet (Phase 1: status, with, unlock --force, log)`);
      return 2;
  }
}

module.exports = { run, splitHost, resolveTarget, resolveLaneOpts, ambiguousHostMessage, homeHygiene, printWait, leaseErrorExit, acquireForLane };
