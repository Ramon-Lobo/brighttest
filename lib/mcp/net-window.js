// @ts-check
'use strict';

// The MCP "session hub window" (ADR 0003 amendments, OD-41; opened by net tools and, STA-S-T15, state write tools; the
// module keeps its createNetWindow name): one lease-held stretch of an MCP session during which the
// session's own LAN hub can serve the app's live traffic. It holds ONE session lease (idle TTL, hard cap) and
// device tool calls re-enter it instead of taking a command lease each.
//
// A session lease has no heartbeat and no onLost, so the window keeps its own view of the lease:
//   - re-entry (acquire with the lease id as token) fails with LEASE_LOST once the lease is gone;
//   - a periodic assertHeld() runs while the window is open;
//   - an idle timer (reset by every device call) and a sessionMax deadline release the window.
// The window is never held without the idle timer (CLAUDE.md rule 9: never hold the lease while idle).

const MAX_IDLE_MS = 10 * 60 * 1000; // sessionIdle default (lib/config.js); the idle TTL is never longer than this
const CHECK_MS = 15000;

function lostError(message) {
  return Object.assign(new Error(message), { code: 'LEASE_LOST' });
}

function unref(t) { if (t && typeof t.unref === 'function') t.unref(); return t; }

// opts: { leaseLib, acquireOpts, storeOpts, idleMs, maxMs, checkMs, onRelease(why) }
//   storeOpts: { env, dir } for leaseLib.renew / tokenValid (they open the lease store themselves)
//   acquireOpts: the host/port/agent/... passed to leaseLib.acquire (the window adds mode, waitMs, idleMs, maxHoldMs)
function createNetWindow(opts) {
  const leaseLib = opts.leaseLib;
  const idleMs = Math.max(1, Math.min(Number(opts.idleMs) || MAX_IDLE_MS, MAX_IDLE_MS));
  const maxMs = opts.maxMs > 0 ? opts.maxMs : 45 * 60 * 1000;
  const checkMs = Math.max(1, Math.min(opts.checkMs > 0 ? opts.checkMs : CHECK_MS, Math.floor(idleMs / 3)));
  const storeOpts = opts.storeOpts || {};
  // The window closes this much BEFORE the lease record can expire (idle or sessionMax), so another agent can never
  // reclaim the device while the window still reports held.
  const marginMs = Math.max(0, Math.min(1000, checkMs, Math.floor(idleMs / 3)));

  /** @type {any} the leaseLib handle (release, assertHeld, mode) */
  let lease = null;
  /** @type {string | null} */
  let leaseId = null;
  /** @type {string | null} */
  let startedAt = null;
  let deadlineAt = 0;
  let open = false;
  let lost = null; // why, once the lease is gone
  let active = 0; // device calls running inside the window
  let idleAt = 0; // when the idle timer fires
  /** @type {any} timer handle (clearTimeout accepts null at runtime) */
  let idleTimer = null;
  /** @type {any} timer handle (clearTimeout accepts null at runtime) */
  let checkTimer = null;
  /** @type {any} timer handle (clearTimeout accepts null at runtime) */
  let maxTimer = null;
  const lostSubs = new Set();

  function clearTimers() {
    clearTimeout(idleTimer); clearTimeout(maxTimer); clearInterval(checkTimer);
    idleTimer = maxTimer = checkTimer = null;
  }

  function armIdle() {
    clearTimeout(idleTimer);
    const wait = Math.max(1, idleMs - marginMs);
    idleAt = Date.now() + wait;
    idleTimer = unref(setTimeout(onIdle, wait));
  }

  function onIdle() {
    idleTimer = null;
    if (!open) return;
    if (active > 0) { armIdle(); return; } // a running call keeps the window; the TTL counts from the call's end
    win.release('idle expiry');
  }

  // `fire`: tell running calls the lease is gone (loss and sessionMax), so they stop with LEASE_LOST.
  function close(why, { fire = false, lostWhy = null } = {}) {
    if (!open) return false;
    open = false;
    if (lostWhy) lost = lostWhy;
    clearTimers();
    const l = lease;
    if (fire) for (const cb of [...lostSubs]) { try { cb(why); } catch { /* best-effort */ } }
    lostSubs.clear();
    // hub.stop() (the owner's onRelease) is async: the hub's port stays bound briefly after the release.
    if (l && typeof l.release === 'function') { try { l.release(`mcp net window: ${why}`); } catch { /* best-effort */ } }
    if (typeof opts.onRelease === 'function') { try { opts.onRelease(why); } catch { /* best-effort */ } }
    return true;
  }

  function markLost(why) { close(why, { fire: true, lostWhy: why }); }

  // The lease FILE has its own idle expiry (expiresAt), pushed forward only by a renew. While a call runs, every
  // tick renews it (a call may outlast the TTL); when idle, a stale or expired record means the lease is lost.
  // A re-entrant command lease (the server runs inside `device with`, ADR 0058) has no idle expiry to push forward and
  // refuses renew: it is alive while its holder file still names it, which assertHeld() answers.
  function renewFile() {
    if (lease && lease.mode && lease.mode !== 'session') {
      if (typeof lease.assertHeld === 'function') lease.assertHeld();
      return;
    }
    if (typeof leaseLib.renew === 'function') leaseLib.renew(leaseId, { ...storeOpts, log: false });
  }

  function check() {
    if (!open) return;
    if (Date.now() >= deadlineAt) { win.release('sessionMax reached', { fire: true }); return; }
    if (active === 0 && Date.now() >= idleAt) { win.release('idle expiry'); return; } // the file expires with the window, not early
    try {
      if (active > 0) renewFile();
      else if (lease && lease.mode && lease.mode !== 'session') renewFile();
      else if (typeof leaseLib.tokenValid === 'function' && !leaseLib.tokenValid(leaseId, storeOpts)) throw new Error('the lease expired or was taken');
      else if (lease && typeof lease.assertHeld === 'function') lease.assertHeld();
    } catch (e) { markLost(`lease lost (${(e && e.message) || 'not held'})`); }
  }

  const win = {
    get isOpen() { return open; },
    get leaseId() { return leaseId; },
    get startedAt() { return startedAt; },
    get lostWhy() { return lost; },
    get idleMs() { return idleMs; },

    // Take the session lease. Lease errors (BUSY, IO, ...) propagate to the caller untouched.
    async open() {
      if (open) return win;
      const got = await leaseLib.acquire({ ...opts.acquireOpts, mode: 'session', waitMs: 0, idleMs, maxHoldMs: maxMs });
      lease = got;
      leaseId = got.leaseId;
      startedAt = new Date().toISOString();
      deadlineAt = Date.now() + Math.max(1, maxMs - marginMs);
      lost = null;
      open = true;
      armIdle();
      maxTimer = unref(setTimeout(() => win.release('sessionMax reached', { fire: true }), Math.max(1, maxMs - marginMs)));
      checkTimer = unref(setInterval(check, checkMs));
      return win;
    },

    // The { held, onLost, leaseId } view a hub (startLanHub) takes. onLost fires on loss and on a sessionMax release,
    // not on an idle release (the owner stops the hub itself).
    view() {
      return {
        leaseId,
        held: () => open,
        onLost: (cb) => { lostSubs.add(cb); },
      };
    },

    // Re-enter the window's lease for one device call: acquire({ token }) on the existing lease, no second lease.
    // Throws LEASE_LOST when the window is gone or the lease was lost.
    async reenter(base) {
      if (!open) throw lostError(lost ? `the net window is gone (${lost}); no request was sent` : 'the net window is not open');
      let re;
      try { re = await leaseLib.acquire({ ...base, token: leaseId }); }
      catch (e) {
        if (e && e.code === 'LEASE_LOST') markLost(`lease lost (${e.message})`);
        throw e;
      }
      armIdle();
      return re;
    },

    // A running call: counts against idle release, and hears about loss. Returns the end function.
    begin(onLostCb) {
      active++;
      if (onLostCb) lostSubs.add(onLostCb);
      armIdle();
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        active = Math.max(0, active - 1);
        if (onLostCb) lostSubs.delete(onLostCb);
        if (open) {
          // the call may have outlasted the file's TTL: renew it right after the idle clock restarts. The timer is
          // armed first so the window's release (idleMs - margin) is always earlier than the record's expiry.
          armIdle();
          try { renewFile(); } catch (e) { markLost(`lease lost (${(e && e.message) || 'not held'})`); }
        }
      };
    },

    touch() { if (open) armIdle(); },

    release(why = 'released', { fire = false } = {}) { return close(why, { fire }); },
    // Run the loss check now (tests, and a call about to use the window).
    check,
  };
  return win;
}

module.exports = { createNetWindow, MAX_IDLE_MS, CHECK_MS };
