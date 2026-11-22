'use strict';
const sg = require('./sgnodes');
const sel = require('./select');

// Launch readiness gate (ROB-04, ADR 0005). Replaces "first successful sgnodes read" after `launch`.
// Ready means all of: the dev channel is in front (active-app), sgnodes answers under a short client timeout,
// two consecutive polls share a focus signature, no osd facade / root system dialog is in front, and the
// optional `readyNode` selector matches. A Home reading is tolerated for a grace window (the app can bounce
// through Home while starting). Pure ECP through the device object; no new transport.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The one place the timing/shape constants live. Per-flow override: flow `config:` keys ready* (see
// resolveConstants). Numbers are starting values, to be tuned from SPK-D4b device data (not yet on record).
const READY_DEFAULTS = Object.freeze({
  timeoutMs: 20000,        // overall deadline (matches the old waitForChannel)
  intervalMs: 250,         // pause between polls
  sgnodesTimeoutMs: 3000,  // short client timeout per sgnodes read; the cold-launch ~7 s FAILED then counts as not-ready
  homeGraceMs: 6000,       // a Home / other-app reading this long after launch is tolerated, then a failed launch
  stableReads: 2,          // consecutive identical focus signatures required
  // Shapes are inference; SPK-D4b has not observed the real osd / system dialog trees yet [D].
  osdSubtypes: Object.freeze(['OsdOverlay', 'Osd']),
  systemDialogRootSubtypes: Object.freeze(['SystemDialog', 'StdDlgSystem']),
});

// flow `config:` key -> constant name (all milliseconds except readyStableReads).
const CONFIG_KEYS = {
  readyTimeout: 'timeoutMs', readyInterval: 'intervalMs', readySgnodesTimeout: 'sgnodesTimeoutMs',
  readyHomeGrace: 'homeGraceMs', readyStableReads: 'stableReads',
};

// Merge defaults <- flow config <- explicit overrides. Ignores non-numeric config values.
function resolveConstants(flowConfig = {}, overrides = {}) {
  const out = { ...READY_DEFAULTS };
  for (const [key, name] of Object.entries(CONFIG_KEYS)) {
    const n = Number(flowConfig[key]);
    if (flowConfig[key] !== undefined && Number.isFinite(n) && n >= 0) out[name] = n;
  }
  return { ...out, ...overrides };
}

// `readyNode` may be a bare id string (flow shorthand) or a selector object.
function readySelector(readyNode) {
  if (readyNode == null || readyNode === '') return null;
  return typeof readyNode === 'object' ? readyNode : { id: String(readyNode) };
}

// 'osd' | 'system-dialog' | null for a parsed tree.
function blockingOverlay(roots, c) {
  for (const r of roots) {
    if (c.osdSubtypes.includes(r.subtype)) return 'osd';
    if (c.systemDialogRootSubtypes.includes(r.subtype)) return 'system-dialog';
  }
  return null;
}

// Poll until ready. Resolves { tree, readyNode, trace } (readyNode = first match of the selector, or null).
// Throws err.code READY_HOME (left in Home / another app past the grace), READY_TIMEOUT (deadline), or
// rethrows LIMITED_MODE. `trace` is [{ atMs, reason }] for each not-ready poll, attached to thrown errors too.
async function waitForReady(device, { appId = 'dev', readyNode, constants, flowConfig, maybeLaunched = false } = {}) {
  const c = resolveConstants(flowConfig, constants);
  const selector = readySelector(readyNode !== undefined ? readyNode : (flowConfig || {}).readyNode);
  // Short client timeout for sgnodes only: wrap ecpGet so fetchTree's call carries it.
  const quick = { ...device, ecpGet: (p) => device.ecpGet(p, c.sgnodesTimeoutMs) };
  const t0 = Date.now();
  const trace = [];
  const fail = (code, msg) => { const e = new Error(msg); e.code = code; e.trace = trace; return e; };
  let prevSig = null;
  let stable = 0;
  let last = 'no poll completed';
  // Consecutive failed sgnodes reads across polls (ROB-10). Each poll makes one read (retries: 0), so the
  // threshold sgnodes.js uses (APP_UI_FALLBACK_AFTER) is met by passing the remainder as fallbackAfter.
  let sgFailures = 0;
  const notReady = (reason) => { last = reason; trace.push({ atMs: Date.now() - t0, reason }); prevSig = null; stable = 0; };

  for (;;) {
    const elapsed = Date.now() - t0;
    let reason = null;
    let tree = null;
    let app = null;
    try { app = await device.activeApp(); } catch (e) { reason = `active-app unreadable: ${e.message}`; }
    if (!reason) {
      if (app.home || app.id !== appId) {
        const what = app.home ? 'Home' : `other app (${app.id})`;
        if (elapsed >= c.homeGraceMs) throw fail('READY_HOME', `launch of ${appId} did not hold: ${what} in front after ${c.homeGraceMs} ms${maybeLaunched ? ' (launch POST returned 404/5xx after sideload)' : ''}`);
        reason = `${what} in front (grace)`;
      }
    }
    if (!reason) {
      try {
        tree = await sg.fetchTree(quick, { retries: 0, fallbackAfter: Math.max(1, sg.APP_UI_FALLBACK_AFTER - sgFailures) });
        // An app-ui tree is not an sgnodes success: keep the count so the next poll falls back at once.
        if (tree.source === sg.TREE_SOURCE_SGNODES) sgFailures = 0;
      } catch (e) {
        if (e.code === 'LIMITED_MODE') throw e;
        // CHANNEL_NOT_RUNNING never falls back and breaks the run of failures; anything else counts.
        sgFailures = e.code === 'CHANNEL_NOT_RUNNING' ? 0 : sgFailures + 1;
        // CHANNEL_NOT_RUNNING, the cold-launch FAILED, an RPC timeout and an aborted (short-timeout) read are all not-ready.
        reason = `sgnodes not ready: ${e.code || e.name || 'error'}`;
      }
    }
    if (!reason) {
      const overlay = blockingOverlay(tree.roots, c);
      if (overlay) reason = `${overlay} in front`;
      else if (selector && !sel.matchAll(tree.roots, selector).length) reason = 'readyNode not found';
    }
    if (reason) notReady(reason);
    else {
      const sig = sg.focusSignature(tree.roots);
      if (sig === prevSig) stable++; else { prevSig = sig; stable = 1; }
      if (stable >= c.stableReads) {
        return { tree, readyNode: selector ? sel.matchAll(tree.roots, selector)[0] || null : null, trace };
      }
      last = 'waiting for a stable focus signature';
    }
    if (Date.now() - t0 >= c.timeoutMs) throw fail('READY_TIMEOUT', `${appId} not ready after ${c.timeoutMs} ms (${last})`);
    await sleep(c.intervalMs);
  }
}

module.exports = { waitForReady, resolveConstants, READY_DEFAULTS, readySelector, blockingOverlay };
