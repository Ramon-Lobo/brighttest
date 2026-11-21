'use strict';
const leaseLib = require('../device-lease');
const { resolveEcpPort } = require('../devices');

// Studio's side of the device lease. Studio is long-lived and human-driven, so it holds a command lease
// (its server PID) only while it is being used:
// - the first device poll from an open tab, or any user action, acquires without queueing (wait 0);
// - user actions (keypress, run, launch, console, starting a profiling session…) mark activity; background
//   polls and a profiling session that is merely running do not (the session is stopped when Studio yields);
// - losing or releasing the lease aborts the operations in flight (a flow running through /api/run);
// - it releases after `studioIdle` without activity, or after `studioYield` when someone is queued;
// - after such a release (or a lost lease) polls get 423 until the user acts again or asks to take over
//   (POST /api/lease {action:"acquire"}), which queues Studio like any other waiter. Studio never preempts.

class StudioLease {
  constructor({ host = null, cfg = null, env = process.env, port = null, now = () => Date.now(), log = (s) => process.stdout.write(s + '\n'), acquireOpts = {}, lib = leaseLib } = {}) {
    this.lib = lib;
    this.env = env;
    this.now = now;
    this.log = log;
    this.port = port;
    this.acquireOpts = acquireOpts;
    this.settings = lib.resolveSettings({ cfg, env });
    this.lease = null;
    this.yielded = false;
    this.pending = null;     // a queued take-over in progress
    this.acquiring = null;   // a wait-0 attempt in progress (serializes concurrent polls)
    this.lastActivity = 0;
    this.busy = 0;           // in-flight user operations (a running flow): never released under them
    this.lastError = null;
    this.inflight = new Set(); // AbortControllers of running user operations
    this.onRelease = () => {};
    this.setHost(host);
  }

  setHost(host) {
    if (this.host === host) return;
    this.release('device changed');
    this.host = host || null;
    this.ecpPort = resolveEcpPort(null, this.env);
    this.yielded = false;
  }

  get holding() { return !!(this.lease && !this.lease.lost && !this.lease.expired); }

  baseOpts() {
    return {
      host: this.host, port: this.ecpPort, env: this.env,
      agent: this.env.BRIGHTTEST_AGENT || undefined,
      purpose: `studio${this.port ? ` :${this.port}` : ''}`,
      command: ['brighttest', 'studio'],
      maxHoldMs: this.settings.maxHoldMs, exitOnLost: false,
      onLost: (reason) => this.dropped(`lease lost (${reason})`),
      onExpire: () => this.dropped('lease reached its deadline'),
      ...this.acquireOpts,
    };
  }

  // Tell every in-flight operation the lease is gone (it must stop touching the device).
  abortInflight(why) {
    for (const ac of [...this.inflight]) ac.abort(why);
  }

  dropped(why) {
    this.lease = null;
    this.abortInflight(why);
    this.yielded = true;
    this.log(`[brighttest lease] studio no longer holds ${this.host}: ${why}`);
    this.onRelease(why);
  }

  gotLease(l, how) {
    this.lease = l;
    this.key = l.key;
    this.yielded = false;
    this.lastActivity = this.now();
    this.lastError = null;
    if (!l.reentrant) this.log(`[brighttest lease] studio holds ${this.host} (${how})`);
  }

  // Make sure Studio holds the lease before touching the device. `user` = a user action (marks activity and
  // may re-acquire after a yield); polls only acquire when Studio has not yielded. Returns true if holding.
  async ensure({ user = false } = {}) {
    if (!this.host) return true; // no device: the endpoint answers "no device connected" itself
    if (this.holding) { if (user) this.lastActivity = this.now(); return true; }
    if (this.pending) return false;
    if (!user && this.yielded) return false;
    if (!this.acquiring) {
      this.acquiring = this.lib.acquire({ ...this.baseOpts(), waitMs: 0 })
        .then((l) => { this.gotLease(l, user ? 'user action' : 'first poll'); return true; })
        .catch((e) => { if (e.code !== 'BUSY') this.lastError = e.message; return false; })
        .finally(() => { this.acquiring = null; });
    }
    const ok = await this.acquiring;
    if (ok && user) this.lastActivity = this.now();
    return ok;
  }

  // "Take over when free": queue like anyone else (wait from config/env), never preempt.
  takeOver() {
    if (!this.host || this.holding || this.pending) return;
    this.log(`[brighttest lease] studio queued for ${this.host}`);
    this.pending = this.lib.acquire({ ...this.baseOpts(), waitMs: this.settings.waitMs })
      .then((l) => this.gotLease(l, 'take over'))
      .catch((e) => { this.lastError = e.message; this.log(`[brighttest lease] studio gave up waiting for ${this.host}: ${e.message}`); })
      .finally(() => { this.pending = null; });
  }

  release(why = 'released') {
    const l = this.lease;
    this.lease = null;
    if (l) this.abortInflight(`studio released the device (${why})`);
    if (l && !l.reentrant) {
      l.release(why);
      this.log(`[brighttest lease] studio released ${this.host} (${why})`);
      this.onRelease(why);
    }
  }

  // An audit note in the device's events.log (e.g. profiling stopped because Studio yielded). Best-effort.
  note(text) {
    try {
      if (this.lease && this.lease.note) return this.lease.note(text);
      if (this.key) this.lib.createStore({ env: this.env, ...this.acquireOpts }).logEvent(this.key, { ev: 'note', agent: this.baseOpts().agent, purpose: this.baseOpts().purpose, note: String(text) });
    } catch { /* the audit log is best-effort */ }
  }

  // Run fn as a user operation: no idle/yield release while it is in flight.
  // fn receives an AbortSignal that fires when the lease is lost or released while it runs.
  async during(fn) {
    this.busy++;
    const ac = new AbortController();
    this.inflight.add(ac);
    try { return await fn(ac.signal); } finally { this.inflight.delete(ac); this.busy--; this.lastActivity = this.now(); }
  }

  // Called about once a second: idle release, or yield to a queued waiter.
  tick() {
    if (!this.holding || this.busy > 0) return;
    const t = this.now();
    const idle = t - this.lastActivity;
    if (idle >= this.settings.studioIdleMs) { this.release(`idle ${this.lib.formatDuration(idle)}`); this.yielded = true; return; }
    if (idle >= this.settings.studioYieldMs) {
      let queued = [];
      try { queued = this.lib.status({ env: this.env, ...this.acquireOpts, key: this.lease.key })[0].queue; } catch { /* unreadable: keep */ }
      if (queued.length) {
        this.release(`yielded to ${queued[0].agent}`);
        this.yielded = true;
      }
    }
  }

  // Status JSON for /api/lease and 423 bodies.
  async info() {
    let st = null;
    if (this.host) {
      try {
        const key = this.lease ? this.lease.key : await this.lib.normalizeKey(this.host, { port: this.ecpPort });
        st = this.lib.status({ env: this.env, ...this.acquireOpts, key })[0];
      } catch { /* lease dir unreadable */ }
    }
    const h = st && st.holder ? st.holder : null;
    return {
      host: this.host, key: st ? st.key : null, holding: this.holding, queued: !!this.pending, yielded: this.yielded,
      holder: h ? { agent: h.holder.agent, purpose: h.holder.purpose, since: h.acquiredAt, deadline: h.deadline, worktree: h.holder.worktree, branch: h.holder.branch, mine: this.holding && h.leaseId === this.lease.leaseId } : null,
      queue: st ? st.queue.map((q) => ({ agent: q.agent, purpose: q.purpose, since: q.queuedAt })) : [],
      error: this.lastError,
    };
  }

  // A one-line description of who holds the device (for 423 errors and the text banner).
  static describe(info) {
    if (info.holder && !info.holder.mine) {
      const since = info.holder.since ? new Date(info.holder.since).toTimeString().slice(0, 5) : '?';
      return `Device in use by ${info.holder.agent} — "${info.holder.purpose}" (since ${since})`;
    }
    if (info.queue.length) return `Device is free but ${info.queue.length} waiter(s) are queued`;
    return 'Studio released the device (idle)';
  }
}

module.exports = { StudioLease };
