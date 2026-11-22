'use strict';
const readline = require('readline');
const { TOOLS, CONTRACT, LIMITS, validate, confineFlowPath, fail } = require('./tools');

// `brighttest mcp`: a stdio MCP server (newline-delimited JSON-RPC 2.0), hand-rolled, no dependency
// (ADR 0003). stdout carries protocol messages only; every log goes to stderr. One session per process:
// the device lease is taken on the first device-touching tool call and released when the session ends.

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
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
    this.lease = null;
    this._leasing = null;
    this._lane = Promise.resolve(); // device tools run one at a time per session
    this._device = null;
    this._lastPressEnd = 0;
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

  exclusive(fn) {
    const run = this._lane.then(fn);
    this._lane = run.then(() => undefined, () => undefined);
    return run;
  }

  async ensureLease(t) {
    if (this.lease) return;
    if (!this._leasing) {
      this._leasing = (async () => {
        let cfg;
        try { cfg = require('../config').loadConfig(this.cwd, null); } catch { cfg = { rootDir: this.cwd }; }
        const acquire = this.deps.acquireForLane || require('../device-command').acquireForLane;
        const got = await acquire({
          cfg, opts: { wait: '0', purpose: 'brighttest mcp session', as: this.env.BRIGHTTEST_AGENT || undefined },
          host: t.host, ecpPort: t.ecpPort, password: t.password, command: ['brighttest', 'mcp'], hygiene: false, allowBypass: false,
          mode: 'command', env: this.env, deps: { onWait: () => {} },
        });
        if (got.code != null || !got.lease) {
          const busy = got.code === 75;
          throw fail(busy ? 'DEVICE_BUSY' : got.code === 77 ? 'LEASE_LOST' : got.code === 78 ? 'LEASE_DIR_UNUSABLE' : 'LEASE_FAILED',
            busy ? `device ${t.host} is in use by another brighttest session (see \`brighttest device status\`); no request was sent. Retry later.`
              : `could not take the device lease on ${t.host} (exit ${got.code})`, { data: { exitCode: got.code } });
        }
        this.lease = got.lease;
      })();
      this._leasing.catch(() => { this._leasing = null; });
    }
    await this._leasing;
  }

  async deviceHandle() {
    const t = this.target();
    await this.ensureLease(t);
    if (!this._device) this._device = this.createDevice({ host: t.host, password: t.password, ecpPort: t.ecpPort });
    return { device: this._device, target: t };
  }

  async waitPressGap() {
    const wait = this._lastPressEnd + this.limits.pressGapMs - Date.now();
    if (wait > 0) await sleep(wait);
  }

  releaseLease(why) {
    const l = this.lease;
    this.lease = null;
    this._leasing = null;
    if (l && typeof l.release === 'function') { try { l.release(why || 'mcp session ended'); } catch { /* best-effort */ } }
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

  inspectTree(args) {
    return this.exclusive(async () => {
      const sg = require('../e2e/sgnodes');
      const sel = require('../e2e/select');
      const { device } = await this.deviceHandle();
      const cap = Math.min(args.maxNodes || this.limits.maxTreeNodes, this.limits.maxTreeNodes);
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
        if (out.length >= cap) { truncated = out.length >= this.limits.maxTreeNodes ? 'node-cap' : 'maxNodes'; break; }
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

  press(args) {
    const { VALID_KEYS } = require('../e2e/flow');
    const key = args.key;
    if (!(VALID_KEYS.includes(key) || /^Lit_.$/u.test(key))) {
      throw fail('INVALID_KEY', `unknown key "${key}"; valid keys: ${VALID_KEYS.join(', ')}, or Lit_<char> for one literal character`, { data: { validKeys: VALID_KEYS } });
    }
    const count = args.count || 1;
    return this.exclusive(async () => {
      this.checkPressBudget(count);
      const { device } = await this.deviceHandle();
      let done = 0;
      try {
        for (let i = 0; i < count; i++) {
          await this.waitPressGap();
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

  navigateTo(args) {
    return this.exclusive(async () => {
      const sg = require('../e2e/sgnodes');
      const nav = require('../e2e/navigate');
      const { device } = await this.deviceHandle();
      const left = this.limits.maxPressesPerSession - this.pressed;
      const max = Math.min(args.maxPresses || this.limits.maxNavigatePresses, left);
      if (max < 1) this.checkPressBudget(1);
      const keys = [];
      const wrapper = Object.create(device);
      wrapper.keypress = async (k) => {
        await this.waitPressGap();
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

  screenshot() {
    return this.exclusive(async () => {
      const { device, target } = await this.deviceHandle();
      if (!target.password) throw fail('NO_DEV_PASSWORD', 'screenshots need the device dev password, configured out of band (ROKU_PASSWORD in the environment or a project .env, or the device cache); it is never a tool parameter');
      const { buffer, ext } = await device.screenshot();
      if (buffer.length > this.limits.maxScreenshotBytes) {
        throw fail('SCREENSHOT_TOO_LARGE', `screenshot is ${buffer.length} bytes, over the ${this.limits.maxScreenshotBytes}-byte cap; nothing was truncated`, { data: { bytes: buffer.length, cap: this.limits.maxScreenshotBytes } });
      }
      return { __image: { data: buffer.toString('base64'), mimeType: ext === 'png' ? 'image/png' : 'image/jpeg' }, bytes: buffer.length, format: ext };
    });
  }

  appState() {
    return this.exclusive(async () => {
      const sg = require('../e2e/sgnodes');
      const appstate = require('../e2e/appstate');
      const { device } = await this.deviceHandle();
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
    return this.exclusive(async () => {
      if (this.flowRuns >= this.limits.maxFlowRunsPerSession) {
        throw fail('FLOW_BUDGET_EXHAUSTED', `session flow-run cap reached (${this.limits.maxFlowRunsPerSession}). The cap resets only with a new MCP session.`, { data: { cap: this.limits.maxFlowRunsPerSession } });
      }
      const { loadFlow, checkRequires, FlowError } = require('../e2e/flow');
      const { execStep, guardDevice } = require('../e2e/run');
      let flow;
      try { flow = loadFlow(file); }
      catch (e) { throw fail('FLOW_INVALID', e instanceof FlowError ? e.message : String(e.message)); }
      const { device } = await this.deviceHandle();
      this.flowRuns++;
      const info = await device.deviceInfo();
      const steps = [];
      const summary = (extra) => ({ flow: flow.name, total: flow.steps.length, passed: steps.filter((s) => s.ok).length, steps, ...extra });
      const why = flow.requires ? checkRequires(flow.requires, info) : null;
      if (why) return summary({ skipped: why });
      const ctx = {
        device: guardDevice(device, call.signal), cfg: { rootDir: this.cwd }, opts: { screenshotsMode: 'off', rootDir: this.cwd }, flow,
        stepTimeoutMs: (flow.config.timeout || 10) * 1000, deviceInfo: info, noSystemDialog: flow.config.noSystemDialog === true, signal: call.signal,
      };
      for (let i = 0; i < flow.steps.length; i++) {
        const step = flow.steps[i];
        try {
          const { detail } = await execStep(step, ctx);
          steps.push({ index: i, op: step.op, line: step.line, ok: true, ...(detail ? { detail: String(detail) } : {}) });
        } catch (e) {
          if (e && e.code === 'REQUIRES_UNMET') return summary({ skipped: e.message });
          steps.push({ index: i, op: step.op, line: step.line, ok: false, message: String(e && e.message), ...(e && e.code ? { code: e.code } : {}) });
          throw fail('FLOW_FAILED', `flow ${flow.name} failed at step ${i + 1} (${step.op}): ${e && e.message}`, { data: summary({ failedStep: i }) });
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
// opts: { input, output, errput, cwd, deps, limits, env, version }. Returns { done, close }.
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

  async function callTool(tool, args) {
    const ac = new AbortController();
    const limit = tool.name === 'run_flow' ? session.limits.flowTimeoutMs : session.limits.toolTimeoutMs;
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => { const e = fail('TOOL_TIMEOUT', `${tool.name} exceeded its ${limit} ms budget and was stopped; the server is still responsive`, { data: { budgetMs: limit } }); ac.abort(e.message); rej(e); }, limit);
    });
    try {
      const work = Promise.resolve().then(() => tool.handler(args, session, { signal: ac.signal }));
      work.catch(() => {}); // a result dropped after the timeout must not become an unhandled rejection
      return toolResult(await Promise.race([work, timeout]), false);
    } catch (e) {
      const body = { code: codeOf(e), message: redact(e && e.message) };
      if (e && e.data !== undefined) {
        try { Object.assign(body, JSON.parse(JSON.stringify(e.data, (k, v) => (typeof v === 'string' ? redact(v) : v)))); } catch { /* data is optional */ }
      }
      return toolResult(body, true);
    } finally { clearTimeout(timer); }
  }

  async function handle(msg) {
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    if (method === 'initialize') {
      const want = params && params.protocolVersion;
      initialized = true;
      return send({ id, result: {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(want) ? want : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'brighttest-mcp', version },
        instructions: `${CONTRACT}. Deterministic Roku e2e primitives. The device comes from the server environment (ROKU_HOST, ROKU_PASSWORD); no tool takes a host or password. The first device tool call takes the device lease for this session.`,
      } });
    }
    if (method === 'ping') return isRequest && send({ id, result: {} });
    if (!initialized) return isRequest && rpcError(id, -32002, 'server not initialized: send initialize first');
    if (method === 'notifications/initialized' || (typeof method === 'string' && method.startsWith('notifications/'))) return undefined;
    if (!isRequest) return undefined;
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
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return rpcError(msg && typeof msg === 'object' && !Array.isArray(msg) ? msg.id : null, -32600, 'invalid request: expected a JSON-RPC 2.0 object with a method');
    }
    const p = handle(msg).catch((e) => { log(`internal error: ${e && e.message}`); if (msg.id !== undefined && msg.id !== null) rpcError(msg.id, -32603, 'internal error'); });
    pending.add(p);
    p.finally(() => pending.delete(p));
  }

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', onLine);
  const done = new Promise((resolve) => {
    rl.on('close', async () => {
      closing = true;
      await Promise.allSettled([...pending]);
      session.releaseLease('mcp session ended');
      resolve(0);
    });
  });

  return {
    done,
    session,
    close() { if (!closing) rl.close(); return done; },
  };
}

// CLI entry: serve on process stdio until stdin closes. Returns the exit code.
async function run(opts = {}) {
  const server = createMcpServer(opts);
  const onFatal = (e) => { try { process.stderr.write(`[brighttest mcp] fatal: ${e && e.message}\n`); } catch { /* ignore */ } server.session.releaseLease('mcp session error'); process.exit(1); };
  process.once('uncaughtException', onFatal);
  return server.done;
}

module.exports = { createMcpServer, run, Session, SUPPORTED_PROTOCOLS };
