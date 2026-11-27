'use strict';
const leaseLib = require('../device-lease');
const { resolveEcpPort } = require('../devices');
const deviceIdentity = require('../device-identity');

// Studio's side of the device lease. Studio is long-lived and human-driven, so it holds a command lease
// (its server PID) only while it is being used:
// - the first device poll from an open tab, or any user action, acquires without queueing (wait 0);
// - user actions (keypress, run, launch, console, starting a profiling session…) mark activity; background
//   polls and a profiling session that is merely running do not (the session is stopped when Studio yields);
// - losing or releasing the lease aborts the operations in flight (a flow running through /api/run);
// - it releases after `studioIdle` without activity, or after `studioYield` when someone is queued;
// - after such a release (or a lost lease) polls get 423 until the user acts again or asks to take over
//   (POST /api/lease {action:"acquire"}), which queues Studio like any other waiter. Studio never preempts.

const YIELDED_TEXT = 'Studio yielded the device (a run may be using it)';

class StudioLease {
  constructor({ host = null, cfg = null, env = process.env, port = null, now = () => Date.now(), log = (s) => process.stdout.write(s + '\n'), acquireOpts = {}, lib = leaseLib, pool = null, onBind = null, identityKeyFor = deviceIdentity.identityKeyFor, identityRead = false } = {}) {
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
    this.ac = new AbortController(); // aborted by cancel(): setHost and server close drop waiting acquires
    this.poolIds = null;     // { keys, gateKey } of the pool, computed on first use
    this.acquiring = null;   // a wait-0 attempt in progress (serializes concurrent polls)
    this.lastActivity = 0;
    this.busy = 0;           // in-flight user operations (a running flow): never released under them
    this.lastError = null;
    this.inflight = new Set(); // AbortControllers of running user operations
    this.onRelease = () => {};
    // A device pool (deviceLease.pool, no explicit host): each acquire takes exactly one free member via acquirePool and
    // binds this.host to it (onBind tells the server which device to talk to). An explicit host always wins.
    this.pool = !host && Array.isArray(pool) && pool.length ? pool : null;
    this.onBind = onBind || (() => {});
    this.identityKeyFor = identityKeyFor;
    this.identityRead = identityRead; // true: one bounded device-info read when no key is remembered (else remembered keys only)
    this.identityKey = null;  // the device's identity lease key (taken before the address key), once resolved
    this.identityP = null;    // the resolution in progress, per host
    this.setHost(host);
  }

  // Drop any acquire still waiting (a queued take-over, a wait-0 attempt): a lease it wins later is released at once.
  cancel() {
    this.ac.abort();
    this.ac = new AbortController();
    this.pending = null;
    this.acquiring = null;
  }

  setHost(host) {
    // Connecting to a named device (even the bound member) leaves pool mode: drop a queued pool pick (it would rebind
    // to another member), but never a lease already held on that member.
    if (host && this.pool) { this.pool = null; if (!this.holding) this.cancel(); }
    if (this.host === host) return;
    this.cancel();
    this.release('device changed');
    this.host = host || null;
    this.ecpPort = resolveEcpPort(null, this.env);
    this.yielded = false;
    this.identityKey = null; // a new device: resolve its identity again
    this.identityP = null;
  }

  get holding() { return !!(this.lease && !this.lease.lost && !this.lease.expired); }

  // acquire or acquirePool (pool mode), with the options of baseOpts.
  // Resolves with the lease. The caller captures `const ac = this.ac` first and hands the lease to adopt().
  acquire(extra) {
    const go = async () => {
      const o = { ...this.baseOpts(), signal: this.ac.signal, ...extra };
      if (!this.pool) return this.lib.acquire(o);
      delete o.host;
      await this.poolInfo();
      return this.lib.acquirePool({ ...o, hosts: this.pool });
    };
    const idp = this.resolveIdentity();
    return idp ? idp.then(go) : go(); // no identity to resolve (cached, pool, stub lib): acquire at once
  }

  // The identity key of the device, resolved once per host and cached: the remembered key (a plain file read), else,
  // with identityRead, one bounded device-info read. Unknown leaves it null: Studio then leases by address only.
  // An explicit acquireOpts key/identity wins. Returns null when there is nothing to wait for, else a promise.
  resolveIdentity() {
    const ao = this.acquireOpts;
    if (this.pool || !this.host || ao.key || ao.deviceId || ao.identityKey || this.identityKey) return null;
    if (typeof this.lib.defaultDir !== 'function') return null; // a stubbed lease lib has no identity
    const host = this.host;
    const dir = ao.dir || this.lib.defaultDir(this.env);
    if (!this.identityRead) {
      try { this.identityKey = deviceIdentity.recalledKey(dir, host, this.ecpPort) || null; } catch { this.identityKey = null; }
      return null;
    }
    if (!this.identityP) {
      this.identityP = Promise.resolve(this.identityKeyFor(host, this.ecpPort, { dir }))
        .catch(() => null)
        .then((k) => { if (this.host === host) this.identityKey = k || null; return this.identityKey; });
    }
    return this.identityP;
  }

  // A lease that resolved after cancel() (ac is no longer current) is released at once, never adopted.
  adopt(l, ac, how) {
    if (ac !== this.ac) {
      try { l.release('cancelled'); } catch { /* best-effort */ }
      return false;
    }
    this.gotLease(l, how);
    return true;
  }

  // Member keys and gate key of the pool (the gate queue is where pool waiters stand).
  async poolInfo() {
    if (!this.pool) return null;
    if (!this.poolIds && this.lib.poolKeys) {
      const o = this.baseOpts(); // the same {port, lookup} acquirePool derives its keys from
      const keys = await this.lib.poolKeys(this.pool, { port: o.port, lookup: o.lookup });
      this.poolIds = { keys, gateKey: this.lib.poolGateKey(keys) };
    }
    return this.poolIds;
  }

  // Someone else is waiting for this device (or for a pool device): the waiters on the held key and, in pool mode,
  // on the pool gate (a holder there is a pick in progress). Studio's own queued take-over is not "someone else".
  waiters() {
    const out = [];
    const read = (key) => { try { return this.lib.status({ env: this.env, ...this.acquireOpts, key })[0]; } catch { return null; } };
    // Every key the lease holds (identity and address): a taker queued on either one is waiting for this device.
    const seen = new Set();
    for (const k of (this.lease.keys && this.lease.keys.length ? this.lease.keys : [this.lease.key])) {
      const m = read(k);
      if (m) for (const q of m.queue) { if (!q.leaseId || !seen.has(q.leaseId)) { if (q.leaseId) seen.add(q.leaseId); out.push(q); } }
    }
    if (this.pool && this.poolIds) {
      const g = read(this.poolIds.gateKey);
      if (g) { out.push(...g.queue); if (g.holder && !this.pending && !this.acquiring) out.push({ agent: g.holder.holder.agent, purpose: g.holder.holder.purpose }); }
    }
    return out;
  }

  baseOpts() {
    return {
      host: this.host, port: this.ecpPort, env: this.env,
      ...(this.identityKey ? { identityKey: this.identityKey } : {}),
      agent: this.env.BRIGHTTEST_AGENT || undefined,
      purpose: `studio${this.port ? ` :${this.port}` : ''}`,
      command: ['brighttest', 'studio'],
      kind: 'interactive', yieldAfterMs: this.settings.studioYieldMs, idleReleaseMs: this.settings.studioIdleMs,
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
    if (l.poolHost && l.poolHost !== this.host) { this.host = l.poolHost; this.onBind(l.poolHost); }
    this.key = l.key;
    this.yielded = false;
    this.lastActivity = this.now();
    this.lastError = null;
    this.annotate({ activityAt: new Date(this.lastActivity).toISOString(), busy: false });
    if (!l.reentrant) this.log(`[brighttest lease] studio holds ${this.host} (${how})`);
  }

  // Tell the lease record about user activity and busy (interactive holder fields). Best-effort; throttled by the lease.
  annotate(patch) {
    try { if (this.lease && typeof this.lease.annotate === 'function') this.lease.annotate(patch); } catch { /* best-effort */ }
  }

  // Make sure Studio holds the lease before touching the device. `user` = a user action (marks activity and
  // may re-acquire after a yield); polls only acquire when Studio has not yielded. Returns true if holding.
  async ensure({ user = false } = {}) {
    if (!this.host && !this.pool) return true; // no device: the endpoint answers "no device connected" itself
    if (this.holding) { if (user) this.markActivity(); return true; }
    if (this.pending) return false;
    if (!user && this.yielded) return false;
    if (!this.acquiring) {
      const ac = this.ac;
      const p = this.acquire({ waitMs: 0 })
        .then((l) => this.adopt(l, ac, user ? 'user action' : 'first poll'))
        .catch((e) => { if (e.code !== 'BUSY' && e.code !== 'CANCELLED') this.lastError = e.message; return false; })
        .finally(() => { if (this.acquiring === p) this.acquiring = null; });
      this.acquiring = p;
    }
    const ok = await this.acquiring;
    if (ok && user) this.markActivity();
    return ok;
  }

  markActivity() {
    this.lastActivity = this.now();
    this.annotate({ activityAt: new Date(this.lastActivity).toISOString() });
  }

  // "Take over when free": queue like anyone else (wait from config/env), never preempt.
  takeOver() {
    if ((!this.host && !this.pool) || this.holding || this.pending) return;
    this.log(`[brighttest lease] studio queued for ${this.host || 'a pool device'}`);
    const ac = this.ac;
    const p = this.acquire({ waitMs: this.settings.waitMs })
      .then((l) => { this.adopt(l, ac, 'take over'); })
      .catch((e) => { if (e.code === 'CANCELLED') return; this.lastError = e.message; this.log(`[brighttest lease] studio gave up waiting for ${this.host || 'a pool device'}: ${e.message}`); })
      .finally(() => { if (this.pending === p) this.pending = null; });
    this.pending = p;
  }

  // Long-poll take-over (POST /api/lease {action:"acquire", wait}): queue like takeOver() and resolve true as soon as
  // Studio holds the device, or false when `waitMs` ends first. The wait ends at once on `signal` (client gone). A take-over
  // this call queued is dropped when it gives up, so no waiter or timer outlives the request. No polling: the wake-up is the
  // queued acquire settling.
  async acquireWithin(waitMs, { signal } = {}) {
    if (await this.ensure({ user: true })) return true;
    const started = !this.pending;
    if (started) this.takeOver();
    const p = this.pending;
    if (!p) return this.holding;
    let timer = null;
    let onAbort = null;
    const ended = new Promise((resolve) => {
      timer = setTimeout(resolve, waitMs);
      if (signal) { onAbort = resolve; if (signal.aborted) resolve(); else signal.addEventListener('abort', onAbort, { once: true }); }
    });
    try { await Promise.race([p, ended]); }
    finally { clearTimeout(timer); if (signal && onAbort) signal.removeEventListener('abort', onAbort); }
    if (this.holding) { this.markActivity(); return true; }
    if (started && this.pending === p) this.cancel(); // gave up: leave the queue
    return false;
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
    if (this.busy === 1) this.annotate({ busy: true, activityAt: new Date(this.now()).toISOString() });
    const ac = new AbortController();
    this.inflight.add(ac);
    try { return await fn(ac.signal); } finally { this.inflight.delete(ac); this.busy--; this.lastActivity = this.now(); this.annotate({ ...(this.busy === 0 ? { busy: false } : {}), activityAt: new Date(this.lastActivity).toISOString() }); }
  }

  // Called about once a second: idle release, or yield to a queued waiter.
  tick() {
    if (!this.holding || this.busy > 0) return;
    const t = this.now();
    const idle = t - this.lastActivity;
    if (idle >= this.settings.studioIdleMs) { this.release(`idle ${this.lib.formatDuration(idle)}`); this.yielded = true; return; }
    if (idle >= this.settings.studioYieldMs) {
      const queued = this.waiters();
      if (queued.length) {
        this.release(`yielded to ${queued[0].agent}`);
        this.yielded = true;
      }
    }
  }

  // Status JSON for /api/lease and 423 bodies. In pool mode `poolState` says how many members are busy and by whom
  // (host + agent only: a held Studio lease still names exactly one `key`), and `queue` merges the member's and the
  // pool gate's waiters.
  async info() {
    let st = null;
    let gate = null;
    let poolState = null;
    const read = (key) => { try { return this.lib.status({ env: this.env, ...this.acquireOpts, key })[0]; } catch { return null; } };
    if (this.pool) {
      const ids = await this.poolInfo().catch(() => null);
      if (ids) {
        gate = read(ids.gateKey);
        const sts = ids.keys.map(read);
        const holders = [];
        sts.forEach((m, i) => { if (m && m.holder) holders.push({ host: this.pool[i], agent: m.holder.holder.agent, purpose: m.holder.holder.purpose, mine: this.holding && this.lease.key === ids.keys[i] }); });
        poolState = { size: this.pool.length, busy: holders.length, holders };
        if (this.lease) st = sts.find((m) => m && m.key === this.lease.key) || null;
      }
    } else if (this.host) {
      try {
        const key = this.lease ? this.lease.key : await this.lib.normalizeKey(this.host, { port: this.ecpPort });
        st = read(key);
      } catch { /* lease dir unreadable */ }
    }
    const h = st && st.holder ? st.holder : null;
    const queue = [...(st ? st.queue : []), ...(gate ? gate.queue : [])];
    const info = {
      host: this.host, pool: !!this.pool, poolState, key: st ? st.key : null, holding: this.holding, queued: !!this.pending, yielded: this.yielded,
      holder: h ? { agent: h.holder.agent, purpose: h.holder.purpose, since: h.acquiredAt, deadline: h.deadline, worktree: h.holder.worktree, branch: h.holder.branch, mine: this.holding && h.leaseId === this.lease.leaseId } : null,
      queue: queue.map((q) => ({ agent: q.agent, purpose: q.purpose, since: q.queuedAt })),
      error: this.lastError,
    };
    info.text = StudioLease.describe(info);
    return info;
  }

  // A one-line description of who holds the device (for 423 errors and the text banner).
  static describe(info) {
    const ps = info.poolState;
    if (info.holding && (!info.holder || info.holder.mine)) return `Studio holds ${info.host || info.key || 'the device'}`;
    if (info.pool && !info.holding) {
      if (info.queued) return ps && ps.busy >= ps.size ? `Studio is queued: all ${ps.size} pool devices are busy` : 'Studio is queued for a pool device';
      if (ps && ps.busy >= ps.size) return `All ${ps.size} pool devices are busy (${[...new Set(ps.holders.map((x) => x.agent))].join(', ')})`;
      if (info.queue.length) return `Device pool has a free device but ${info.queue.length} waiter(s) are queued`;
      if (ps) return `Device pool: ${ps.size - ps.busy} of ${ps.size} free`;
      return info.yielded ? YIELDED_TEXT : 'Studio released the device (idle)';
    }
    if (info.holder && !info.holder.mine) {
      const since = info.holder.since ? new Date(info.holder.since).toTimeString().slice(0, 5) : '?';
      return `Device in use by ${info.holder.agent} — "${info.holder.purpose}" (since ${since})`;
    }
    if (info.queue.length) return `Device is free but ${info.queue.length} waiter(s) are queued`;
    return info.yielded ? YIELDED_TEXT : 'Studio released the device (idle)';
  }
}

module.exports = { StudioLease };
