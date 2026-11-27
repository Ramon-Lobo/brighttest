'use strict';
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { TOOLS, CONTRACT, LIMITS, validate, confineFlowPath, fail } = require('./tools');

// `brighttest mcp`: a stdio MCP server (newline-delimited JSON-RPC 2.0), hand-rolled, no dependency
// (ADR 0003). stdout carries protocol messages only; every log goes to stderr. One session per process.
// Outside a session hub window every device-touching tool call takes its own command lease and releases it when the
// call ends; the first net_requests/net_mock call (or a state write tool, kind 'state') opens a window (one session
// lease the other tools reuse).

// 2025-03-26 is left out on purpose: it allows JSON-RPC batches, which this server does not implement.
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2024-11-05'];
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_MSG_CHARS = 300;
// Keys an agent may not press through MCP (conservative default; Volume* and the rest stay allowed).
const DENIED_KEY = /^(PowerOff|InputTuner|InputHDMI\d|InputAV\d)$/;
const cap = (v, n = MAX_MSG_CHARS) => { const t = String(v); return t.length > n ? t.slice(0, n) + '...' : t; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- per-session device state and tool implementations ----------------------------------------------
// instrument.state.redact.paths from brighttest.json: the masks the hub log applies to state values.
function statePaths(cfg) {
  const r = cfg && cfg.instrument && cfg.instrument.state && cfg.instrument.state.redact;
  return r && Array.isArray(r.paths) ? r.paths.filter((v) => typeof v === 'string') : [];
}

class Session {
  constructor({ cwd, deps = {}, limits = {}, env = process.env }) {
    this.cwd = cwd;
    this.env = env;
    this.limits = { ...LIMITS, ...limits };
    this.deps = deps;
    this.pressed = 0;
    this.flowRuns = 0;
    this.lease = null; // the lease of the call running right now, if any
    this._lane = Promise.resolve(); // device tools run one at a time per session
    this._device = null;
    this._lastPressEnd = 0;
    this._ident = null;
    this.win = null; // the session hub window, while open
    this._hub = null;
    this.hubInfo = null; // { host, port, leaseId, startedAt } of the session hub, while the window is open
    this.agentSeen = false; // the app agent was live on this window's hub (STATE_AGENT_GONE vs STATE_AGENT_UNREACHABLE)
    this.hubNet = false; // the session net proxy is mounted in the window's hub (net tools, or a net-kind opener)
    this.hubLog = () => {}; // the hub log sink (set by createMcpServer: one `[brighttest hub] ...` line per call, on stderr)
    this._hubReqs = new Map(); // net request id -> { method, path } until its response is logged
  }

  // Net proxy events of the session hub as hub log lines: method, path (no query), status, byte counts; never a body.
  hubNetEvent(kind, data) {
    if (!this._hub || !data) return;
    if (kind === 'net.request') {
      let p = '';
      try { p = new URL(String(data.url)).pathname; } catch { p = '?'; }
      this._hubReqs.set(data.id, { method: String(data.method || ''), path: p });
      if (this._hubReqs.size > 1000) this._hubReqs.delete(this._hubReqs.keys().next().value);
    } else if (kind === 'net.response') {
      const r = this._hubReqs.get(data.id) || { method: '?', path: '?' };
      this._hubReqs.delete(data.id);
      this.hubLog(`request ${r.method} ${r.path} -> ${data.status} (${Number(data.bytes) || 0} response bytes, source ${data.source || '?'})`);
    } else if (kind === 'net.error') {
      const r = this._hubReqs.get(data.id) || { method: '?', path: '?' };
      this._hubReqs.delete(data.id);
      // Refused passthrough (403) and bad target (400) events carry the real status and bytes of the proxy response.
      if (Number.isInteger(data.status)) {
        this.hubLog(`request ${r.method} ${r.path} -> ${data.status} (${Number(data.bytes) || 0} response bytes, source ${data.refused ? 'refused' : 'error'})`);
        return;
      }
      if (data.refused) {
        // Fallback for older events without status/bytes: the proxy answered 403 with a fixed text body, so derive them.
        const reason = String(data.detail || '').replace(/^refused: /, '');
        const bytes = Buffer.byteLength(`brighttest net: passthrough refused (${reason}). Add the host to net.upstreamHosts to allow it.\n`);
        this.hubLog(`request ${r.method} ${r.path} -> 403 (${bytes} response bytes, source refused)`);
        return;
      }
      this.hubLog(`request ${r.method} ${r.path} failed (${data.kind || 'error'})`);
    }
  }

  get devices() { return this.deps.devices || require('../devices'); }
  get createDevice() { return this.deps.createDevice || require('../e2e/ecp').createDevice; }

  // The one device this session targets: brighttest's resolution chain only (env, project .env, cache).
  target() {
    const t = this.devices.resolveDevice({ cwd: this.cwd });
    if (!t.host) throw fail('NO_DEVICE', 'no device configured: set ROKU_HOST (and ROKU_PASSWORD for screenshots) in the environment, a project .env, or run `brighttest devices`; these are not tool parameters');
    return { host: t.host, password: t.password, source: t.source, ecpPort: this.devices.resolveEcpPort() };
  }

  secrets() {
    const out = [this.env.ROKU_PASSWORD];
    try { out.push(this.devices.resolveDevice({ cwd: this.cwd }).password); } catch { /* none */ }
    return out.filter(Boolean);
  }

  // A call that timed out while queued never runs: its signal is already aborted when its turn comes.
  exclusive(call, fn) {
    const run = this._lane.then(() => {
      if (call.signal.aborted) throw new Error('dropped before it ran');
      call.begin();
      return fn();
    });
    this._lane = run.then(() => undefined, () => undefined);
    return run;
  }

  // Git identity of the project, read once per session so no git process is spawned per call.
  identity(L) {
    if (!this._ident) this._ident = typeof L.gitIdentity === 'function' ? L.gitIdentity(this.cwd) : { worktree: null, branch: null };
    return this._ident;
  }

  // One command lease around one call. Fails fast when busy (no ECP request is sent). A lost or expired
  // lease aborts the call (LEASE_LOST); it never exits the process.
  async acquireLease(t, call) {
    const L = this.deps.leaseLib || require('../device-lease');
    const budget = (call.limitMs || this.limits.toolTimeoutMs) + 30000;
    try {
      return await L.acquire({
        host: t.host, port: t.ecpPort, agent: this.env.BRIGHTTEST_AGENT || undefined, purpose: 'brighttest mcp tool call',
        command: ['brighttest', 'mcp'], secrets: this.secrets(), env: this.env, mode: 'command', waitMs: 0,
        identity: this.identity(L), cwd: this.cwd, maxHoldMs: budget, idleMs: budget, onWait: () => {}, onWarn: () => {}, foregroundCheck: false,
        onLost: (reason) => call.lose(`lease lost (${reason})`), onExpire: () => call.lose('lease reached its deadline'),
      });
    } catch (e) { throw this.leaseError(e, t); }
  }

  leaseError(e, t) {
    const c = e && e.code;
    if (c === 'BUSY' || c === 'TIMEOUT') return fail('DEVICE_BUSY', `device ${t.host} is in use by another brighttest session (see \`brighttest device status\`); no request was sent. Retry later.`);
    if (c === 'LEASE_LOST') return fail('LEASE_LOST', 'the device lease is not held; no request was sent');
    return fail(c === 'IO' ? 'LEASE_DIR_UNUSABLE' : 'LEASE_FAILED', `could not take the device lease on ${t.host}: ${e && e.message}`);
  }

  // ---- session hub window (NET-N-T15, OD-41; STA-S-T15) ----
  // Lease options shared by the window's session lease and the re-entry of its token.
  windowAcquireOpts(t, L) {
    return { host: t.host, port: t.ecpPort, agent: this.env.BRIGHTTEST_AGENT || undefined, purpose: 'brighttest mcp session hub window',
      command: ['brighttest', 'mcp'], secrets: this.secrets(), env: this.env, identity: this.identity(L), cwd: this.cwd,
      onWait: () => {}, onWarn: () => {}, foregroundCheck: false };
  }

  loadCfg() { try { return require('../config').loadConfig(this.cwd); } catch { return {}; } }

  // Open the window (one session lease, idle TTL never above sessionIdle) and start the session's own LAN hub in it.
  // kind 'net' starts the hub with the session net proxy; kind 'state' starts it without (the hub answers net hellos
  // active:false until a net tool mounts the proxy, see ensureNet). A hub start failure releases the window and fails
  // with NET_FAILED.
  async openWindow(t, kind = 'net') {
    const L = this.deps.leaseLib || require('../device-lease');
    const { createNetWindow } = require('./net-window');
    const cfg = this.loadCfg();
    const st = require('../device-lease').resolveSettings({ cfg, env: this.env });
    const win = createNetWindow({
      leaseLib: L, acquireOpts: this.windowAcquireOpts(t, L), storeOpts: { env: this.env }, idleMs: st.idleMs, maxMs: st.sessionMaxMs,
      onRelease: () => this.windowReleased(win),
    });
    try { await win.open(); } catch (e) { throw this.leaseError(e, t); }
    this.win = win;
    try { await this.startHub(t, win, cfg, { net: kind !== 'state' }); }
    catch (e) {
      win.release('hub start failed');
      const inUse = e && e.code === 'EADDRINUSE';
      throw fail('NET_FAILED', cap(inUse ? 'the instrument hub port is already in use; free it or set instrument.hub.port in brighttest.json' : `the session hub could not start: ${e && e.message}`));
    }
    return win;
  }

  async startHub(t, win, cfg, { net = true } = {}) {
    const { hubAddress, startLanHub } = require('../instrument/hub');
    const addr = hubAddress(cfg);
    const start = this.deps.startLanHub || startLanHub;
    const hub = await start({
      deviceHost: t.host, lease: win.view(), tokens: [require('crypto').randomBytes(16).toString('hex')], port: addr.port, env: this.env,
      log: (s) => this.hubLog(s), redactPaths: statePaths(cfg), ...(net ? { netProxy: this.net().proxy } : {}),
    });
    if (!win.isOpen) { try { await hub.stop(); } catch { /* best-effort */ } throw Object.assign(new Error('the lease was lost while the hub started'), { code: 'LEASE_LOST' }); }
    this._hub = hub;
    this.hubNet = !!net;
    this.hubInfo = { host: addr.host, port: addr.port, leaseId: win.leaseId, startedAt: win.startedAt };
    this.hubLog(`session hub started on port ${addr.port} for ${t.host}`);
  }

  // The window ended (idle, sessionMax, loss, session end, hub failure): drop the hub and its record. The session net
  // proxy and its mocks stay until session end; the next device call takes a command lease.
  windowReleased(win) {
    if (this.win === win) this.win = null;
    const hub = this._hub;
    this._hub = null;
    this.hubInfo = null;
    this.hubNet = false;
    this.agentSeen = false;
    if (hub) this.hubLog('session hub stopped');
    if (hub && typeof hub.stop === 'function') { try { Promise.resolve(hub.stop()).catch(() => {}); } catch { /* best-effort */ } }
  }

  // A net tool inside an open window: mount the session proxy into the running hub if the window was opened by a
  // state tool (D3). Idempotent.
  ensureNet() {
    const hub = this._hub;
    if (!hub || this.hubNet) return;
    try { hub.mountNet(this.net().proxy); } catch (e) { throw fail('NET_FAILED', cap(`the session hub could not mount the network proxy: ${e && e.message}`)); }
    this.hubNet = true;
    this.hubLog('session net proxy mounted');
  }

  // Run fn({ device, target }) in this session's device lane under its own lease. The device handle refuses to
  // act once the call is aborted (timeout, lost lease).
  // window: false | true | 'net' | 'state' (true means 'net'): the kind of window this tool opens when none is open.
  // precheck({ device, target }): runs once under a command lease before a window would open (a throw opens nothing).
  withDevice(call, fn, { window = false, precheck = null } = {}) {
    return this.exclusive(call, async () => {
      const t = this.target();
      if (window && !this.win && precheck) {
        const pl = await this.acquireLease(t, call);
        this.lease = pl;
        try {
          if (!this._device) this._device = this.createDevice({ host: t.host, password: t.password, ecpPort: t.ecpPort });
          await precheck({ device: require('../e2e/run').guardDevice(this._device, call.signal), target: t });
        } finally { if (this.lease === pl) this.lease = null; try { pl.release('mcp precheck ended'); } catch { /* best-effort */ } }
      }
      if (window && !this.win) await this.openWindow(t, window === 'state' ? 'state' : 'net');
      const win = this.win;
      let lease;
      let endCall = null;
      if (win) {
        // Inside the net window: re-enter the window's lease (no second lease); a loss stops this call.
        const L = this.deps.leaseLib || require('../device-lease');
        try { lease = await win.reenter({ ...this.windowAcquireOpts(t, L), mode: 'command' }); } catch (e) { throw this.leaseError(e, t); }
        endCall = win.begin((why) => call.lose(`session hub window ended (${why})`));
      } else lease = await this.acquireLease(t, call);
      this.lease = lease;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        if (this.lease === lease) this.lease = null;
        if (endCall) endCall();
        else try { lease.release('mcp call ended'); } catch { /* best-effort */ }
      };
      call.releaseNow = release; // used only when the lease is already gone (LEASE_LOST)
      try {
        if (call.signal.aborted) throw new Error('aborted');
        if (!this._device) this._device = this.createDevice({ host: t.host, password: t.password, ecpPort: t.ecpPort });
        const { guardDevice } = require('../e2e/run');
        return await fn({ device: guardDevice(this._device, call.signal), target: t });
      } finally { release(); }
    });
  }

  releaseLease(why) {
    if (this.win) this.win.release(why || 'mcp session ended'); // lease first, then the hub; the net proxy goes below
    this.closeNet(); // net mocks are scoped to the session
    const l = this.lease;
    this.lease = null;
    if (l && typeof l.release === 'function') { try { l.release(why || 'mcp session ended'); } catch { /* best-effort */ } }
  }

  async waitPressGap(signal) {
    const wait = this._lastPressEnd + this.limits.pressGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    if (signal && signal.aborted) throw new Error('aborted');
  }

  // ---- tools ----
  async listDevices() {
    const t = this.target0();
    const cached = this.devices.cachedDevices().map((d) => ({ host: d.host, name: d.name || null, hasPassword: !!d.hasPassword, last: !!d.last, active: !!(t && d.host === t.host) }));
    let active = null;
    if (t) {
      if (!cached.some((d) => d.host === t.host)) cached.push({ host: t.host, name: null, hasPassword: !!t.password, last: false, active: true });
      active = { host: t.host, source: t.source, reachable: false, model: null, firmware: null, developerEnabled: null };
      try {
        const caps = await this.createDevice({ host: t.host, password: null, ecpPort: t.ecpPort }).deviceCapabilities();
        Object.assign(active, { reachable: true, model: caps.model || null, firmware: caps.softwareVersion || null, developerEnabled: caps.developerEnabled });
      } catch { /* reachable stays false */ }
    }
    return { contract: CONTRACT, active, devices: cached };
  }

  target0() { try { return this.target(); } catch { return null; } }

  async doctor() {
    const t = this.target();
    const { inspectDevice } = require('../doctor');
    const r = await inspectDevice(t.host, t.ecpPort, { createDevice: this.createDevice });
    delete r.serial;
    if (!r.reachable) throw fail('DEVICE_UNREACHABLE', `device ${t.host} is unreachable: ${r.error}`, { data: { checks: r.checks } });
    return r;
  }

  inspectTree(args, call) {
    return this.withDevice(call, async ({ device }) => {
      const sg = require('../e2e/sgnodes');
      const sel = require('../e2e/select');
      const max = Math.min(args.maxNodes || this.limits.maxTreeNodes, this.limits.maxTreeNodes);
      const tree = args.selector ? await sg.fetchTreeFor(device, args.selector) : await sg.fetchTree(device);
      let list;
      if (args.selector) {
        try { list = sel.matchAll(tree.roots, args.selector).map((n) => ({ node: n, depth: null })); }
        catch (e) { throw fail('INVALID_SELECTOR', e.message); }
      } else {
        list = [];
        (function walk(nodes, depth) { for (const n of nodes) { list.push({ node: n, depth }); walk(n.children, depth + 1); } })(tree.roots, 0);
      }
      const out = [];
      let bytes = 2;
      let truncated = null;
      for (const { node, depth } of list) {
        if (out.length >= max) { truncated = out.length >= this.limits.maxTreeNodes ? 'node-cap' : 'maxNodes'; break; }
        const item = projectNode(node, depth, this.limits.maxTextChars);
        const size = Buffer.byteLength(JSON.stringify(item)) + 1;
        if (bytes + size > this.limits.maxTreeBytes) { truncated = 'byte-cap'; break; }
        bytes += size;
        out.push(item);
      }
      const res = { totalNodes: sg.flatten(tree.roots).length, matched: list.length, returned: out.length, truncated: truncated !== null, bytes };
      if (truncated) res.truncatedReason = truncated;
      res[args.selector ? 'matches' : 'nodes'] = out;
      return res;
    });
  }

  press(args, call) {
    const { VALID_KEYS } = require('../e2e/flow');
    const key = args.key;
    if (!(VALID_KEYS.includes(key) || /^Lit_.$/u.test(key))) {
      throw fail('INVALID_KEY', `unknown key "${key}"; valid keys: ${VALID_KEYS.join(', ')}, or Lit_<char> for one literal character`, { data: { validKeys: VALID_KEYS } });
    }
    if (DENIED_KEY.test(key)) throw fail('KEY_NOT_ALLOWED', `the key "${key}" is not allowed through MCP (power and input-switch keys are blocked by default)`);
    const count = args.count || 1;
    return this.withDevice(call, async ({ device }) => {
      this.checkPressBudget(count);
      let done = 0;
      try {
        for (let i = 0; i < count; i++) {
          await this.waitPressGap(call.signal);
          try { await device.keypress(key); } finally { this._lastPressEnd = Date.now(); }
          done++; this.pressed++;
        }
      } catch (e) { e.data = { ...(e.data || {}), pressed: done, requested: count }; throw e; }
      return { key, pressed: done, sessionPresses: this.pressed, sessionPressCap: this.limits.maxPressesPerSession };
    });
  }

  checkPressBudget(n) {
    const left = this.limits.maxPressesPerSession - this.pressed;
    if (n > left) {
      throw fail('PRESS_BUDGET_EXHAUSTED', `session press cap reached: ${this.pressed} of ${this.limits.maxPressesPerSession} used, ${left} left, ${n} requested. The cap resets only with a new MCP session.`, { data: { used: this.pressed, cap: this.limits.maxPressesPerSession } });
    }
  }

  navigateTo(args, call) {
    return this.withDevice(call, async ({ device }) => {
      const sg = require('../e2e/sgnodes');
      const nav = require('../e2e/navigate');
      const left = this.limits.maxPressesPerSession - this.pressed;
      const max = Math.min(args.maxPresses || this.limits.maxNavigatePresses, left);
      if (max < 1) this.checkPressBudget(1);
      const keys = [];
      const wrapper = Object.create(device);
      wrapper.keypress = async (k) => {
        await this.waitPressGap(call.signal);
        try { await device.keypress(k); } finally { this._lastPressEnd = Date.now(); }
        keys.push(k); this.pressed++;
      };
      const lastFocused = async () => {
        try { return summarizeFocus(nav.focusedNode((await sg.fetchTree(device)).roots)); } catch { return null; }
      };
      let r;
      try { r = await nav.focusTo(wrapper, args.selector, { maxPresses: max }); }
      catch (e) {
        if (e && e.code === 'FOCUS_FAILED') throw fail('FOCUS_FAILED', e.message, { data: { keys, lastFocused: await lastFocused() } });
        if (e && /^selector/.test(e.message || '')) throw fail('INVALID_SELECTOR', e.message);
        e.data = { ...(e.data || {}), keys };
        throw e;
      }
      return { presses: r.presses, keys, focused: await lastFocused() };
    });
  }

  screenshot(call) {
    return this.withDevice(call, async ({ device, target }) => {
      if (!target.password) throw fail('NO_DEV_PASSWORD', 'screenshots need the device dev password, configured out of band (ROKU_PASSWORD in the environment or a project .env, or the device cache); it is never a tool parameter');
      const { buffer, ext } = await device.screenshot();
      if (buffer.length > this.limits.maxScreenshotBytes) {
        throw fail('SCREENSHOT_TOO_LARGE', `screenshot is ${buffer.length} bytes, over the ${this.limits.maxScreenshotBytes}-byte cap; nothing was truncated`, { data: { bytes: buffer.length, cap: this.limits.maxScreenshotBytes } });
      }
      return { __image: { data: buffer.toString('base64'), mimeType: ext === 'png' ? 'image/png' : 'image/jpeg' }, bytes: buffer.length, format: ext };
    });
  }

  appState(call) {
    return this.withDevice(call, async ({ device }) => {
      const sg = require('../e2e/sgnodes');
      const appstate = require('../e2e/appstate');
      // Same lookup order as the assertState flow step: the instrumented agent node (__bt_agent, node-id fast path;
      // a miss falls back to the full tree) first, then the legacy hand-published __bt_state node from that tree.
      const tree = await sg.fetchTreeFor(device, { id: appstate.AGENT_NODE_ID });
      let res;
      let agent;
      try { agent = appstate.extractAgentState(tree.roots, { maxBytes: this.limits.maxStateBytes }); }
      catch (e) {
        if (e && e.code === 'STATE_TOO_LARGE') throw fail('APP_STATE_TOO_LARGE', `app state is over the ${this.limits.maxStateBytes}-byte cap; nothing was truncated`, { data: { cap: this.limits.maxStateBytes } });
        throw e;
      }
      if (agent.present && !agent.error) res = { state: agent.layers, raw: JSON.stringify(agent.layers) };
      else {
        res = appstate.extractAppState(tree.roots);
        if (!res.present && agent.present) throw fail('STATE_UNREADABLE', `the published agent state could not be read: ${agent.error}`);
        if (!res.present) throw fail('STATE_NOT_PUBLISHED', 'the app does not publish state: no __bt_agent or __bt_state node (the build is not instrumented)');
      }
      if (res.error) throw fail('STATE_UNREADABLE', `the published state could not be read: ${res.error}`);
      const bytes = Buffer.byteLength(res.raw, 'utf8');
      if (bytes > this.limits.maxStateBytes) throw fail('APP_STATE_TOO_LARGE', `app state is ${bytes} bytes, over the ${this.limits.maxStateBytes}-byte cap; nothing was truncated`, { data: { bytes, cap: this.limits.maxStateBytes } });
      return { state: res.state, bytes };
    });
  }

  // ---- net tools (NET-N-T14): the session's own proxy and rule set, reused from lib/instrument; mocks end with the session ----
  // The project's instrument.net.redact block (extra headers, query names, JSON paths), so the session proxy and the
  // output redactor mask the same things a headless run does. A missing or unreadable config means the defaults.
  netRedactConfig() {
    try {
      const net = require('../config').loadConfig(this.cwd).instrument.net;
      return net && typeof net === 'object' && net.redact && typeof net.redact === 'object' && !Array.isArray(net.redact) ? net.redact : {};
    } catch { return {}; }
  }

  // instrument.net.upstreamHosts and .unmatched, read like Studio and the headless lane so a passthrough the project
  // allows is not refused here. Invalid values are ignored (the proxy then keeps its safe defaults: refuse, fail).
  netPassthroughConfig() {
    try {
      const n = require('../instrument/net-headless').netBlock(require('../config').loadConfig(this.cwd));
      const out = {};
      if (Array.isArray(n.upstreamHosts)) out.upstreamHosts = n.upstreamHosts;
      if (n.unmatched === 'fail' || n.unmatched === 'passthrough') out.unmatched = n.unmatched;
      return out;
    } catch { return {}; }
  }

  net() {
    if (!this._net) {
      const rules = require('../instrument/net-rules');
      const redact = this.netRedactConfig();
      const pc = this.netPassthroughConfig();
      if (!this.deps.netProxy) {
        try { require('../instrument/net-proxy').assertPassthroughHosts(pc.unmatched, pc.upstreamHosts, 'instrument.net'); } catch (e) { throw fail('NET_CONFIG', e.message); }
      }
      const proxy = this.deps.netProxy || require('../instrument/net-proxy').createNetProxy({ root: this.cwd, redact, ...pc, warn: () => {}, emit: (k, d) => this.hubNetEvent(k, d) });
      this._net = { proxy, ctl: require('../instrument/net-ctl').createNetCtl({ proxy, root: this.cwd }), redactor: rules.makeRedactor(redact), rules: 0 };
    }
    return this._net;
  }

  // One URL glob at the MCP boundary: bounded length (schema) and wildcard count, so a hostile pattern stays cheap.
  checkGlob(url, what) {
    if (url === undefined) return;
    const stars = (String(url).match(/\*/g) || []).length;
    if (stars > this.limits.maxNetWildcards) throw fail('NET_PATTERN_TOO_COMPLEX', `${what} has ${stars} "*" wildcards; at most ${this.limits.maxNetWildcards} are allowed`);
  }

  closeNet() {
    const n = this._net;
    this._net = null;
    if (n && !this.deps.netProxy && typeof n.proxy.close === 'function') { try { n.proxy.close(); } catch { /* best-effort */ } }
  }

  netRequests(args, call) {
    this.checkGlob(args.url, 'net_requests url');
    return this.withDevice(call, async () => {
      const n = this.net();
      this.ensureNet();
      const hubRec = this.hubInfo ? { ...this.hubInfo, leaseId: String(this.hubInfo.leaseId).slice(0, 8) } : null; // the full lease id stays internal
      const filter = {};
      for (const k of ['method', 'url', 'status']) if (args[k] !== undefined) filter[k] = args[k];
      let all;
      try { all = n.ctl.handle('requests', JSON.stringify(filter)); } catch (e) { throw fail('NET_FAILED', e.message); }
      if (all.status !== 200) throw fail('NET_BAD_FILTER', all.json.error);
      const list = all.json.requests;
      const limit = args.limit || 100;
      const shown = list.slice(-limit).map((e) => ({
        id: e.id, method: e.method, url: n.redactor.url(String(e.url).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1')), status: e.status === undefined ? null : e.status, ms: e.ms === undefined ? null : e.ms,
        source: e.source || null, mocked: e.source === 'mock', rule: e.rule || null, error: e.error || null, headers: n.redactor.headers(e.headers),
      }));
      const bytes = Buffer.byteLength(JSON.stringify(shown), 'utf8');
      if (bytes > this.limits.maxNetBytes) throw fail('NET_OUTPUT_TOO_LARGE', `the request list is ${bytes} bytes, over the ${this.limits.maxNetBytes}-byte cap; nothing was truncated. Lower limit or add method, url or status filters`, { data: { bytes, cap: this.limits.maxNetBytes } });
      return { count: list.length, returned: shown.length, truncated: list.length > shown.length, hub: hubRec, requests: shown };
    }, { window: true });
  }

  netMock(args, call) {
    this.checkGlob(args.match.url, 'net_mock match.url');
    return this.withDevice(call, async () => {
      const n = this.net();
      this.ensureNet();
      if (n.rules >= this.limits.maxNetRules) throw fail('NET_RULE_BUDGET_EXHAUSTED', `session net_mock cap reached (${this.limits.maxNetRules} rules). The cap resets only with a new MCP session.`, { data: { cap: this.limits.maxNetRules } });
      const rule = { ...args.match, ...args.respond };
      if (args.times !== undefined) rule.times = args.times;
      const out = n.ctl.handle('mock', JSON.stringify(rule));
      if (out.status !== 200) throw fail('NET_RULE_INVALID', out.json.error);
      n.rules++;
      return { ok: true, id: out.json.id, scope: 'session' };
    }, { window: true });
  }

  runFlow(args, call) {
    const file = confineFlowPath(this.cwd, args.path); // before any read or device call
    return this.withDevice(call, async ({ device }) => {
      if (this.flowRuns >= this.limits.maxFlowRunsPerSession) {
        throw fail('FLOW_BUDGET_EXHAUSTED', `session flow-run cap reached (${this.limits.maxFlowRunsPerSession}). The cap resets only with a new MCP session.`, { data: { cap: this.limits.maxFlowRunsPerSession } });
      }
      const { loadFlow, checkRequires, FlowError } = require('../e2e/flow');
      const { execStep } = require('../e2e/run');
      let flow;
      try { flow = loadFlow(file); }
      catch (e) { throw fail('FLOW_INVALID', e instanceof FlowError ? cap(e.message) : 'the flow could not be read'); }
      this.flowRuns++;
      const info = await device.deviceInfo();
      const steps = [];
      const summary = (extra) => ({ flow: flow.name, total: flow.steps.length, passed: steps.filter((s) => s.ok).length, steps, ...extra });
      const why = flow.requires ? checkRequires(flow.requires, info) : null;
      if (why) return summary({ skipped: cap(why) });
      const realRoot = fs.realpathSync(this.cwd);
      // Same redaction inputs as the CLI runner's makeCtx: the project config (switch and masks), env, the flow's config.
      const cfg = { ...this.loadCfg(), rootDir: this.cwd };
      const opts = { screenshotsMode: 'off', rootDir: this.cwd };
      const ctx = {
        device, cfg, opts, flow, redactState: require('../e2e/appstate').redactStateOn({ cfg, opts, flow }, this.env),
        stepTimeoutMs: (flow.config.timeout || 10) * 1000, deviceInfo: info, noSystemDialog: flow.config.noSystemDialog === true, signal: call.signal,
        // Nested runFlow files get the same confinement as the top-level path, and no parse error echoes file content.
        resolveSubflow: (resolved) => confineFlowPath(this.cwd, path.relative(realRoot, resolved)),
        quietSubflowErrors: true,
      };
      for (let i = 0; i < flow.steps.length; i++) {
        const step = flow.steps[i];
        try {
          const { detail } = await execStep(step, ctx);
          steps.push({ index: i, op: step.op, line: step.line, ok: true, ...(detail ? { detail: cap(detail) } : {}) });
        } catch (e) {
          if (e && e.code === 'REQUIRES_UNMET') return summary({ skipped: cap(e.message) });
          const msg = cap(e && e.message);
          steps.push({ index: i, op: step.op, line: step.line, ok: false, message: msg, ...(e && e.code ? { code: e.code } : {}) });
          throw fail('FLOW_FAILED', `flow ${flow.name} failed at step ${i + 1} (${step.op}): ${msg}`, { data: summary({ failedStep: i }) });
        }
      }
      return summary({});
    });
  }
}

Object.assign(Session.prototype, require('./state-tools').methods); // STA-S-T15: app_state_get/set/snapshot
Object.assign(Session.prototype, require('./perf-tools').methods); // MCP-PERF-T3: perf_summary, perf_trace_summary

function projectNode(n, depth, maxText) {
  const o = { id: n.id, subtype: n.subtype };
  if (depth !== null) o.depth = depth;
  if (n.text != null) { o.text = n.text.length > maxText ? n.text.slice(0, maxText) : n.text; if (n.text.length > maxText) o.textTruncated = true; }
  if (n.bounds) o.bounds = n.bounds;
  if (n.visible !== null) o.visible = n.visible;
  if (n.focusable !== null) o.focusable = n.focusable;
  if (n.focused) o.focused = true;
  return o;
}

function summarizeFocus(n) {
  return n ? { id: n.id, subtype: n.subtype, bounds: n.bounds } : null;
}

function codeOf(e) {
  if (e && typeof e.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(e.code)) return e.code;
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'ECP_TIMEOUT';
  return 'TOOL_FAILED';
}

// ---- the protocol --------------------------------------------------------------------------------------
// opts: { input, output, errput, cwd, deps, limits, env, version }. Returns { done, close, session }.
function createMcpServer(opts = {}) {
  const input = opts.input || process.stdin;
  const output = opts.output || process.stdout;
  const errput = opts.errput || process.stderr;
  const env = opts.env || process.env;
  const session = new Session({ cwd: opts.cwd || process.cwd(), deps: opts.deps, limits: opts.limits, env });
  const version = opts.version || require('../../package.json').version;
  let initialized = false;
  let closing = false;
  const pending = new Set();
  const live = new Set(); // calls that are queued or running

  const send = (msg) => { try { output.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); } catch { /* peer gone */ } };
  const rpcError = (id, code, message) => send({ id: id === undefined ? null : id, error: { code, message } });
  const log = (s) => { try { errput.write(`[brighttest mcp] ${s}\n`); } catch { /* ignore */ } };
  session.hubLog = (s) => { try { errput.write(`[brighttest hub] ${s}\n`); } catch { /* ignore */ } };

  function toolResult(data, isError) {
    if (data && data.__image) {
      const { __image: img, ...meta } = data;
      return { content: [{ type: 'image', data: img.data, mimeType: img.mimeType }, { type: 'text', text: JSON.stringify(meta) }], structuredContent: meta };
    }
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, ...(isError ? { isError: true } : {}) };
  }

  function redact(s) {
    let out = String(s);
    for (const sec of session.secrets()) out = out.split(sec).join('***');
    return out;
  }

  // Budgets: a device call first waits its turn in the session lane (queueWaitMs, then QUEUE_TIMEOUT: it is
  // dropped and never runs); the run budget (toolTimeoutMs / flowTimeoutMs) starts when it gets its turn.
  async function callTool(tool, args) {
    const ac = new AbortController();
    const limit = tool.name === 'run_flow' ? session.limits.flowTimeoutMs : (tool.name === 'app_state_set' || tool.name === 'app_state_snapshot') ? session.limits.stateToolTimeoutMs : session.limits.toolTimeoutMs;
    let timer;
    let rejectTimeout;
    const timeout = new Promise((_, rej) => { rejectTimeout = rej; });
    // Stopping aborts the call so no further device request is sent. The lease is NOT released here: the call's
    // `finally` releases it once in-flight work has settled, so no request can reach the device under another holder.
    const stop = (e, { release = false } = {}) => { ac.abort(e.message); if (release) { try { if (call.releaseNow) call.releaseNow(); } catch { /* best-effort */ } } rejectTimeout(e); };
    const call = {
      signal: ac.signal, limitMs: limit, releaseNow: null,
      begin() {
        clearTimeout(timer);
        timer = setTimeout(() => stop(fail('TOOL_TIMEOUT', `${tool.name} exceeded its ${limit} ms budget and was stopped: no further device requests are sent for it (one request already in flight may still finish), and its lease is released once that request has ended`, { data: { budgetMs: limit } })), limit);
      },
      lose(why) { call.lost = why; stop(fail('LEASE_LOST', `the device ${why}; ${tool.name} was stopped`), { release: true }); },
      cancel() { stop(fail('SESSION_CLOSED', `the MCP session was closed; ${tool.name} was stopped`)); },
      lost: null,
    };
    if (tool.lease) {
      const wait = session.limits.queueWaitMs;
      timer = setTimeout(() => stop(fail('QUEUE_TIMEOUT', `${tool.name} waited ${wait} ms behind earlier device calls of this session and was dropped before it ran; no request was sent`, { data: { queueWaitMs: wait } })), wait);
    } else call.begin();
    live.add(call);
    try {
      const work = Promise.resolve().then(() => tool.handler(args, session, call));
      work.catch(() => {}); // a result dropped after a stop must not become an unhandled rejection
      return toolResult(await Promise.race([work, timeout]), false);
    } catch (e) {
      const body = { code: call.lost ? 'LEASE_LOST' : codeOf(e), message: redact(e && e.message) };
      if (e && e.data !== undefined) {
        try { Object.assign(body, JSON.parse(JSON.stringify(e.data, (k, v) => (typeof v === 'string' ? redact(v) : v)))); } catch { /* data is optional */ }
      }
      return toolResult(body, true);
    } finally { clearTimeout(timer); live.delete(call); }
  }

  async function handle(msg) {
    const { id, method, params } = msg;
    if (method === 'initialize') {
      const want = params && params.protocolVersion;
      initialized = true;
      return send({ id, result: {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(want) ? want : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'brighttest-mcp', version },
        instructions: `${CONTRACT}. Deterministic Roku e2e primitives. The device comes from the server environment (ROKU_HOST, ROKU_PASSWORD); no tool takes a host or password. Each device tool call takes the device lease for that call only, except inside the session hub window: the first net_requests or net_mock call (or a state write tool, app_state_set / app_state_snapshot) holds one device lease for the session; the first state write also waits up to 35 s for the app's agent to connect to the session hub, and needs BRIGHTTEST_HUB_TOKEN in the server environment. The window is released after 10 minutes without a device call, at session end, or on lease loss. app_state_get reads over ECP and never opens a window. perf_trace_summary takes no lease.`,
      } });
    }
    if (method === 'ping') return send({ id, result: {} });
    if (!initialized) return rpcError(id, -32002, 'server not initialized: send initialize first');
    if (method === 'tools/list') return send({ id, result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) } });
    if (method === 'tools/call') {
      const p = params;
      if (!p || typeof p !== 'object' || typeof p.name !== 'string') return rpcError(id, -32602, 'invalid params: params.name (tool name) is required');
      const tool = TOOLS.find((t) => t.name === p.name);
      if (!tool) return rpcError(id, -32602, `unknown tool: ${p.name}`);
      const args = p.arguments === undefined ? {} : p.arguments;
      const bad = validate(tool.inputSchema, args, 'arguments');
      if (bad) return rpcError(id, -32602, `invalid params: ${bad}`);
      return send({ id, result: await callTool(tool, args) });
    }
    return rpcError(id, -32601, `method not found: ${method}`);
  }

  function onLine(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return rpcError(null, -32700, 'parse error: not valid JSON'); }
    const isObj = msg && typeof msg === 'object' && !Array.isArray(msg);
    if (isObj && msg.method === undefined && ('result' in msg || 'error' in msg)) return undefined; // a client's response to us: ignored
    const validId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
    if (!isObj || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return rpcError(isObj && validId(msg.id) ? msg.id : null, -32600, 'invalid request: expected a JSON-RPC 2.0 object with a method');
    }
    if (msg.id === undefined) return undefined; // a notification (including initialize and notifications/*): never answered
    if (!validId(msg.id)) return rpcError(null, -32600, 'invalid request: id must be a string or a number');
    const p = handle(msg).catch((e) => { log(`internal error: ${e && e.message}`); rpcError(msg.id, -32603, 'internal error'); });
    pending.add(p);
    p.finally(() => pending.delete(p));
    return undefined;
  }

  // Line splitter with a length cap: an over-long line is answered with -32700 and discarded to its newline.
  const decoder = new StringDecoder('utf8');
  let buf = '';
  let skipping = false;
  const feed = (chunk) => {
    buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (skipping) { skipping = false; continue; }
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) { rpcError(null, -32700, `parse error: line over ${MAX_LINE_BYTES} bytes`); continue; }
      onLine(line);
    }
    if (buf.length * 3 > MAX_LINE_BYTES && Buffer.byteLength(buf) > MAX_LINE_BYTES) { if (!skipping) rpcError(null, -32700, `parse error: line over ${MAX_LINE_BYTES} bytes`); skipping = true; buf = ''; }
  };
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const onEnd = async () => {
    if (closing) return;
    closing = true;
    if (buf.trim() && !skipping) onLine(buf);
    for (const c of [...live]) c.cancel(); // stdin closed mid-call: stop the work, then let it settle and release
    await Promise.allSettled([...pending]);
    await Promise.race([session._lane, sleep(15000)]); // let a stopped call finish its in-flight request and release its lease
    session.releaseLease('mcp session ended');
    finish(0);
  };
  input.on('data', feed);
  input.on('end', onEnd);
  input.on('close', onEnd);

  return {
    done,
    session,
    close() { onEnd(); return done; },
  };
}

// CLI entry: serve on process stdio until stdin closes. Returns the exit code. Anything the code (or a library)
// prints with console.log goes to stderr so stdout stays protocol-only.
async function run(opts = {}) {
  const util = require('util');
  const toErr = (...a) => { try { process.stderr.write(util.format(...a) + '\n'); } catch { /* ignore */ } };
  console.log = toErr; console.info = toErr; console.debug = toErr;
  const server = createMcpServer(opts);
  const onFatal = (e) => { try { process.stderr.write(`[brighttest mcp] fatal: ${e && e.message}\n`); } catch { /* ignore */ } server.session.releaseLease('mcp session error'); process.exit(1); };
  process.once('uncaughtException', onFatal);
  // A stop signal or a normal exit must not leave the net window's session lease held until its idle TTL. Release
  // synchronously, then restore the default signal behavior by re-raising it.
  const stopped = () => { try { server.session.releaseLease('mcp session stopped'); } catch { /* best-effort */ } };
  process.once('exit', stopped);
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.once(sig, () => { stopped(); process.kill(process.pid, sig); });
  }
  process.stdin.resume();
  return server.done;
}

module.exports = { createMcpServer, run, Session, SUPPORTED_PROTOCOLS };
