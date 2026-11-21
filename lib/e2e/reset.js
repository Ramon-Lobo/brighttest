'use strict';
const { createDevice: defaultCreateDevice } = require('./ecp');

// Device reset (ROB-06): bring a device to a known-good state before a run.
//   resetDevice  - installer Delete (frees a halted app / stuck installer page), Home keypress, then poll
//                  active-app until a Home shape (isHome) or the deadline.
//   probeLeavesHome - launch the app and check the device actually leaves Home. A device that stays on Home
//                  ("never left Home") cannot run flows.
//   resetAndProbe - up to `attempts` rounds of reset + probe; the host is dead after that many consecutive
//                  rounds that fail.
// Callers hold the device lease. Every wait has a deadline.

// Consecutive failed attempts before a host is marked dead (design: TP-ROB-14).
const DEAD_AFTER = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollUntil(cond, { timeoutMs, intervalMs, sleepFn = sleep, now = Date.now }) {
  const end = now() + timeoutMs;
  for (;;) {
    let v = false;
    try { v = await cond(); } catch { v = false; }
    if (v) return true;
    if (now() >= end) return false;
    await sleepFn(intervalMs);
  }
}

// Delete, Home, poll. Throws (with .code) when the Delete fails or Home is never reached; resolves { ms }.
async function resetDevice({ host, password, ecpPort, installerPort, homeTimeoutMs = 10000, pollMs = 300, createDevice, sleepFn, now = Date.now }) {
  const dev = (createDevice || defaultCreateDevice)({ host, password, ecpPort, installerPort });
  const t0 = now();
  const del = await dev.deleteApp();
  if (!del.ok) throw Object.assign(new Error(del.message), { code: 'RESET_DELETE_FAILED' });
  await dev.keypress('Home');
  const home = await pollUntil(() => dev.isHome(), { timeoutMs: homeTimeoutMs, intervalMs: pollMs, sleepFn, now });
  if (!home) throw Object.assign(new Error(`${host} did not reach Home within ${homeTimeoutMs} ms of the reset`), { code: 'RESET_NO_HOME' });
  return { ms: now() - t0 };
}

// Launch appId and wait for the device to leave Home. Resolves true/false.
async function probeLeavesHome({ host, password, ecpPort, installerPort, appId = 'dev', leaveTimeoutMs = 8000, pollMs = 300, createDevice, sleepFn, now = Date.now }) {
  const dev = (createDevice || defaultCreateDevice)({ host, password, ecpPort, installerPort });
  try { await dev.launch(appId, {}, { maybeLaunched: true }); } catch { return false; }
  return pollUntil(async () => !(await dev.isHome()), { timeoutMs: leaveTimeoutMs, intervalMs: pollMs, sleepFn, now });
}

// -> { ok, attempts, reason } ; ok false = dead. A device-level failure (Delete refused, unreachable, no Home)
// counts as a failed attempt, same as "never left Home".
async function resetAndProbe(args, { attempts = DEAD_AFTER } = {}) {
  let reason = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      await resetDevice(args);
      if (await probeLeavesHome(args)) return { ok: true, attempts: i, reason: null };
      reason = 'never left Home';
    } catch (e) { reason = e.message; }
  }
  return { ok: false, attempts, reason };
}

// `brighttest device reset`: one lease window (no Home hygiene: the reset does its own Home) around
// Delete + Home + poll. rc 0 on Home reached, 1 on a failed reset (the lease is released either way),
// the lease's own code (75/77/78) when it cannot be had, 2 without a host or password.
async function cmdReset(o, cfg, deps = {}) {
  const dc = require('../device-command');
  const say = (s) => process.stderr.write(s + '\n');
  const t = (deps.resolveTarget || dc.resolveTarget)(o);
  if (!t.host) { say('[brighttest device] reset: no device host: pass --host or set ROKU_HOST'); return 2; }
  if (!t.password) { say('[brighttest device] reset: the installer Delete needs the dev password: --host ip:pw, --password or ROKU_PASSWORD'); return 2; }
  const got = await (deps.acquireForLane || dc.acquireForLane)({
    cfg, opts: { ...o, purpose: o.purpose || 'device reset' }, command: ['brighttest', 'device', 'reset'],
    host: t.host, ecpPort: t.ecpPort, password: t.password, hygiene: false, allowBypass: false,
  });
  if (got.code != null) return got.code;
  try {
    const r = await resetDevice({ host: t.host, password: t.password, ecpPort: t.ecpPort, installerPort: deps.installerPort, createDevice: deps.createDevice });
    process.stdout.write(`device reset: ${t.host} is at Home (${(r.ms / 1000).toFixed(1)} s)\n`);
    return 0;
  } catch (e) {
    const why = e && e.cause && e.cause.code ? ` (${e.cause.code}; is port 80 reachable on ${t.host}?)` : '';
    say(`[brighttest device] reset failed: ${String(e.message).split(t.password).join('***')}${why}`);
    return 1;
  } finally { if (got.lease) got.lease.release(); }
}

module.exports = { resetDevice, probeLeavesHome, resetAndProbe, cmdReset, DEAD_AFTER };
