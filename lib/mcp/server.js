'use strict';
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { TOOLS, CONTRACT, LIMITS, validate, confineFlowPath, fail } = require('./tools');

// `brighttest mcp`: a stdio MCP server (newline-delimited JSON-RPC 2.0), hand-rolled, no dependency
// (ADR 0003). stdout carries protocol messages only; every log goes to stderr. One session per process.
// Every device-touching tool call takes its own command lease and releases it when the call ends.

// 2025-03-26 is left out on purpose: it allows JSON-RPC batches, which this server does not implement.
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2024-11-05'];
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_MSG_CHARS = 300;
// Keys an agent may not press through MCP (conservative default; Volume* and the rest stay allowed).
const DENIED_KEY = /^(PowerOff|InputTuner|InputHDMI\d|InputAV\d)$/;
const cap = (v, n = MAX_MSG_CHARS) => { const t = String(v); return t.length > n ? t.slice(0, n) + '...' : t; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- per-session device state and tool implementations ----------------------------------------------
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
        identity: this.identity(L), cwd: this.cwd, maxHoldMs: budget, idleMs: budget, onWait: () => {}, onWarn: () => {},
        onLost: (reason) => call.lose(`lease lost (${reason})`), onExpire: () => call.lose('lease reached its deadline'),
      });
    } catch (e) {
      const c = e && e.code;
      if (c === 'BUSY' || c === 'TIMEOUT') throw fail('DEVICE_BUSY', `device ${t.host} is in use by another brighttest session (see \`brighttest device status\`); no request was sent. Retry later.`);
      if (c === 'LEASE_LOST') throw fail('LEASE_LOST', 'the device lease is not held; no request was sent');
      throw fail(c === 'IO' ? 'LEASE_DIR_UNUSABLE' : 'LEASE_FAILED', `could not take the device lease on ${t.host}: ${e && e.message}`);
    }
  }

  // Run fn({ device, target }) in this session's device lane under its own lease. The device handle refuses to
  // act once the call is aborted (timeout, lost lease).
  withDevice(call, fn) {
    return this.exclusive(call, async () => {
      const t = this.target();
      const lease = await this.acquireLease(t, call);
      this.lease = lease;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        if (this.lease === lease) this.lease = null;
        try { lease.release('mcp call ended'); } catch { /* best-effort */ }
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
      const tree = await sg.fetchTreeFor(device, { id: appstate.STATE_NODE_ID });
      const res = appstate.extractAppState(tree.roots);
      if (!res.present) throw fail('STATE_NOT_PUBLISHED', 'the app does not publish state: no __bt_state node (the build is not instrumented)');
      if (res.error) throw fail('STATE_UNREADABLE', `the published state could not be read: ${res.error}`);
      const bytes = Buffer.byteLength(res.raw, 'utf8');
      if (bytes > this.limits.maxStateBytes) throw fail('APP_STATE_TOO_LARGE', `app state is ${bytes} bytes, over the ${this.limits.maxStateBytes}-byte cap; nothing was truncated`, { data: { bytes, cap: this.limits.maxStateBytes } });
      return { state: res.state, bytes };
    });
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
      const ctx = {
        device, cfg: { rootDir: this.cwd }, opts: { screenshotsMode: 'off', rootDir: this.cwd }, flow,
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
    const limit = tool.name === 'run_flow' ? session.limits.flowTimeoutMs : session.limits.toolTimeoutMs;
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
        instructions: `${CONTRACT}. Deterministic Roku e2e primitives. The device comes from the server environment (ROKU_HOST, ROKU_PASSWORD); no tool takes a host or password. Each device tool call takes the device lease for that call only.`,
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
  process.stdin.resume();
  return server.done;
}

module.exports = { createMcpServer, run, Session, SUPPORTED_PROTOCOLS };
