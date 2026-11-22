'use strict';

// The MCP "net window" (ADR 0003 amendment, OD-41): one lease-held stretch of an MCP session during which the
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

// opts: { leaseLib, acquireOpts, idleMs, maxMs, checkMs, onRelease(why) }
//   acquireOpts: the host/port/agent/... passed to leaseLib.acquire (the window adds mode, waitMs, idleMs, maxHoldMs)
function createNetWindow(opts) {
  const leaseLib = opts.leaseLib;
  const idleMs = Math.max(1, Math.min(Number(opts.idleMs) || MAX_IDLE_MS, MAX_IDLE_MS));
  const maxMs = opts.maxMs > 0 ? opts.maxMs : 45 * 60 * 1000;
  const checkMs = opts.checkMs > 0 ? opts.checkMs : CHECK_MS;

  let lease = null;
  let leaseId = null;
  let startedAt = null;
  let deadlineAt = 0;
  let open = false;
  let lost = null; // why, once the lease is gone
  let active = 0; // device calls running inside the window
  let idleTimer = null;
  let checkTimer = null;
  let maxTimer = null;
  const lostSubs = new Set();

  function clearTimers() {
    clearTimeout(idleTimer); clearTimeout(maxTimer); clearInterval(checkTimer);
    idleTimer = maxTimer = checkTimer = null;
  }

  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = unref(setTimeout(onIdle, idleMs));
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
    if (l && typeof l.release === 'function') { try { l.release(`mcp net window: ${why}`); } catch { /* best-effort */ } }
    if (typeof opts.onRelease === 'function') { try { opts.onRelease(why); } catch { /* best-effort */ } }
    return true;
  }

  function markLost(why) { close(why, { fire: true, lostWhy: why }); }

  function check() {
    if (!open) return;
    if (Date.now() >= deadlineAt) { win.release('sessionMax reached', { fire: true }); return; }
    try { if (lease && typeof lease.assertHeld === 'function') lease.assertHeld(); }
    catch (e) { markLost(`lease lost (${(e && e.message) || 'not held'})`); }
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
      deadlineAt = Date.now() + maxMs;
      lost = null;
      open = true;
      armIdle();
      maxTimer = unref(setTimeout(() => check(), maxMs));
      checkTimer = unref(setInterval(check, checkMs));
      return win;
    },

    // The { held, onLost, leaseId } view a hub (startLanHub) takes. onLost fires on loss, sessionMax and idle release.
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
        if (open) armIdle();
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
