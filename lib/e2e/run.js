'use strict';
const fs = require('fs');
const path = require('path');
const { palette } = require('../reporter');
const { createDevice } = require('./ecp');
const { resolveEcpPort } = require('../devices');
const { acquireForLane } = require('../device-command');
const doctor = require('../doctor');
const sg = require('./sgnodes');
const { waitForReady } = require('./ready');
const logsLib = require('./logs');
const sel = require('./select');
const nav = require('./navigate');
const ab = require('./assert-builder');
const appstate = require('./appstate');
const { parseFlow, loadFlow, collectFlowFiles, FlowError } = require('./flow');

// The `brighttest e2e` lane: drive a flow file on a real Roku over ECP and assert on the live SceneGraph
// tree. Deterministic and author-first — no model in the loop. Reuses the reporter palette for a grouped
// ✓/✗ view consistent with the other lanes. See design/e2e-lane.md.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Walk a dot-separated path ("global.channel", "watchlist.0.id") into a plain object. Returns undefined
// if any segment is missing — used by assertState against the app's published state snapshot.
function getPath(obj, dotted) {
  let cur = obj;
  for (const key of String(dotted).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

// Bounded sgnodes reads on the interactive path: fail fast (a few retries) rather than hammering a
// render thread that's busy with video, so polls stay responsive and never hang.
const READ_OPTS = { retries: 3, backoffMs: 150 };

// Resolve the device target from flags, falling back to ROKU_HOST/ROKU_PASSWORD (same convention the
// --device lane documents).
function resolveTarget(opts) {
  return {
    host: opts.host || process.env.ROKU_HOST || null,
    password: opts.password || process.env.ROKU_PASSWORD || null,
    ecpPort: resolveEcpPort(opts.ecpPort), // --ecp-port > ROKU_ECP_PORT > 8060
  };
}

// A step run on behalf of a caller that can withdraw (Studio losing its device lease) carries an AbortSignal
// in ctx.signal: once it fires, nothing may touch the device any more.
function throwIfAborted(signal) {
  if (signal && signal.aborted) throw new Error(String(signal.reason || 'aborted'));
}

// Wrap a device so every method call throws once `signal` has fired. Methods run with the wrapper as `this`,
// so a loop inside one (keypressSeq, text) stops at its next call.
function guardDevice(device, signal) {
  if (!signal) return device;
  return new Proxy(device, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function') return v;
      return function guarded(...args) { throwIfAborted(signal); return v.apply(this === undefined ? receiver : this, args); };
    },
  });
}

// Poll `fn` until it returns a truthy value or the timeout elapses. Returns the value or null. A thrown
// fn (e.g. a transient sgnodes RPC timeout while the render thread is busy buffering video) is treated as
// "not yet" so polling keeps trying until the deadline rather than failing the assertion outright.
async function pollUntilBase(fn, { timeoutMs, intervalMs = 250, signal = null }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    throwIfAborted(signal);
    let v = null;
    try { v = await fn(); } catch (e) { throwIfAborted(signal); v = null; }
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

// Let the UI settle after an action, but never fail the action if the settle read times out — a keypress
// that kicks off heavy work (video buffering, a screen transition) can peg the render thread; the keypress
// itself already succeeded, and the next step's assertion polls for the real state anyway.
async function settle(device) {
  try { await sg.fetchTree(device, { retries: 1, backoffMs: 100 }); } catch (e) { /* best-effort */ }
  await sleep(150);
}

// After launch, sgnodes reports "Channel not running" until the scene is up — wait it out.
async function waitForChannel(device, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return await sg.fetchTree(device, READ_OPTS); }
    catch (e) {
      if (e.code === 'CHANNEL_NOT_RUNNING' && Date.now() < deadline) { await sleep(500); continue; }
      throw e;
    }
  }
}

// One step's runtime context.
function makeCtx(device, cfg, opts, flow) {
  const stepTimeoutMs = (opts.timeout || flow.config.timeout || 10) * 1000;
  return { device, cfg, opts, flow, stepTimeoutMs };
}

// Execute a single normalized step. Returns { detail } on success; throws Error on failure (message is
// shown to the user). Assertions poll until satisfied or the step timeout elapses.
async function execStep(step, ctx) {
  const { device, stepTimeoutMs } = ctx;
  const pollUntil = (fn, o) => pollUntilBase(fn, { ...o, signal: ctx.signal });
  switch (step.op) {
    case 'launch': {
      const appId = ctx.opts.app || ctx.flow.appId || 'dev';
      // Matrix params (ctx.launchParams) override the flow's own launch params for deep-link sweeps.
      const params = { ...(step.params || {}), ...(ctx.launchParams || {}) };
      const status = await device.launch(appId, params, { maybeLaunched: !!ctx.opts.afterSideload });
      // The gate (not the launch POST) decides readiness: a sideload can return before sgnodes is up.
      // Dev channel only; other channel ids keep the previous behaviour (ADR 0005 open item 3, option a).
      if (appId === 'dev') await waitForReady(device, { appId, flowConfig: ctx.flow.config, maybeLaunched: status >= 400 });
      else { await waitForChannel(device); await sg.waitForSettle(device); }
      return { detail: appId + (Object.keys(params).length ? ' (deep link)' : '') };
    }
    case 'press':
      await device.keypressSeq(step.key, step.count);
      await settle(device);
      return { detail: step.count > 1 ? `${step.key} ×${step.count}` : step.key };
    case 'back':
      await device.keypress('Back'); await settle(device); return { detail: 'Back' };
    case 'home':
      await device.keypress('Home'); await sleep(800); return { detail: 'Home' };
    case 'screenshot':
      // The capture itself is driven by runFlow()/maybeScreenshot() (it honors --screenshots-mode and
      // needs the flow/index context); here the step is just a settled marker.
      return { detail: step.name };
    case 'text':
      await device.text(step.value); await settle(device); return { detail: JSON.stringify(step.value) };
    case 'wait':
      await sleep(step.ms); return { detail: `${step.ms}ms` };
    case 'assertMedia': {
      // Poll the ECP media-player (not sgnodes) so it holds up during fullscreen playback.
      const timeout = step.timeout ? step.timeout * 1000 : stepTimeoutMs;
      let last = 'none';
      const ok = await pollUntil(async () => {
        const mp = await device.mediaPlayer();
        last = mp.state;
        return mp.state === step.state ? mp : null;
      }, { timeoutMs: timeout });
      if (!ok) throw new Error(`media player did not reach state ${JSON.stringify(step.state)} within ${timeout / 1000}s (last: ${last})`);
      return { detail: `media ${step.state}` };
    }
    case 'runFlow': {
      // Load a subflow relative to the parent flow, substitute ${env} in its text, run its steps inline.
      const base = ctx.flow && ctx.flow.file ? path.dirname(ctx.flow.file) : (ctx.opts && ctx.opts.rootDir) || process.cwd();
      const subPath = path.resolve(base, step.file);
      let text;
      try { text = fs.readFileSync(subPath, 'utf8'); }
      catch { throw new Error(`runFlow: cannot read ${step.file}`); }
      const env = step.env || {};
      text = text.replace(/\$\{(\w+)\}/g, (m, k) => (k in env ? String(env[k]) : m));
      let sub;
      try { sub = parseFlow(text); } catch (e) { throw new Error(`runFlow ${step.file}: ${e.message}`); }
      const depth = (ctx._depth || 0) + 1;
      if (depth > 10) throw new Error(`runFlow: nesting too deep (cycle via ${step.file}?)`);
      const subCtx = { ...ctx, flow: { ...sub, file: subPath }, _depth: depth };
      for (let i = 0; i < sub.steps.length; i++) {
        throwIfAborted(ctx.signal);
        try { await execStep(sub.steps[i], subCtx); }
        catch (e) { throw new Error(`runFlow ${step.file} → step ${i + 1} (${sub.steps[i].op}): ${e.message}`); }
      }
      return { detail: `${step.file} (${sub.steps.length} step${sub.steps.length === 1 ? '' : 's'})` };
    }
    case 'focus': {
      const { presses } = await nav.focusTo(device, step.selector, { maxPresses: step.maxPresses });
      return { detail: `${sel.describe(step.selector)} (${presses} press${presses === 1 ? '' : 'es'})` };
    }
    case 'pressUntil': {
      for (let i = 0; i < step.max; i++) {
        throwIfAborted(ctx.signal);
        const tree = await sg.fetchTree(device, READ_OPTS);
        if (sel.matchOne(tree.roots, step.selector)) return { detail: `${sel.describe(step.selector)} after ${i} press(es)` };
        await device.keypress(step.key);
        await sg.waitForSettle(device);
      }
      const tree = await sg.fetchTree(device, READ_OPTS);
      if (sel.matchOne(tree.roots, step.selector)) return { detail: `${sel.describe(step.selector)} after ${step.max} press(es)` };
      throw new Error(`pressUntil: ${sel.describe(step.selector)} not visible after ${step.max}× ${step.key}`);
    }
    case 'assertVisible':
    case 'waitFor': {
      const timeout = step.timeout ? step.timeout * 1000 : stepTimeoutMs;
      const found = await pollUntil(async () => sel.matchOne((await sg.fetchTree(device, READ_OPTS)).roots, step.selector), { timeoutMs: timeout });
      if (!found) throw new Error(`${sel.describe(step.selector)} not visible within ${timeout / 1000}s`);
      return { detail: sel.describe(step.selector) };
    }
    case 'assertGone': {
      const gone = await pollUntil(async () => (sel.matchOne((await sg.fetchTree(device, READ_OPTS)).roots, step.selector) ? false : true), { timeoutMs: stepTimeoutMs });
      if (!gone) throw new Error(`${sel.describe(step.selector)} still visible after ${stepTimeoutMs / 1000}s`);
      return { detail: sel.describe(step.selector) };
    }
    case 'assertFocused': {
      const ok = await pollUntil(async () => {
        const n = sel.matchOne((await sg.fetchTree(device, READ_OPTS)).roots, step.selector);
        return n && n.focused ? n : null;
      }, { timeoutMs: stepTimeoutMs });
      if (!ok) throw new Error(`${sel.describe(step.selector)} not focused within ${stepTimeoutMs / 1000}s`);
      return { detail: sel.describe(step.selector) };
    }
    case 'assertText': {
      let lastText = null;
      const ok = await pollUntil(async () => {
        const n = sel.matchOne((await sg.fetchTree(device, READ_OPTS)).roots, step.selector);
        if (!n) return null;
        lastText = n.text;
        if (step.equals !== undefined) return n.text === step.equals ? n : null;
        return (n.text || '').includes(step.contains) ? n : null;
      }, { timeoutMs: stepTimeoutMs });
      if (!ok) {
        const want = step.equals !== undefined ? `equals ${JSON.stringify(step.equals)}` : `contains ${JSON.stringify(step.contains)}`;
        const got = lastText === null ? 'node not found' : `got ${JSON.stringify(lastText)}`;
        throw new Error(`assertText ${sel.describe(step.selector)} ${want} — ${got}`);
      }
      return { detail: `${sel.describe(step.selector)} ${step.equals !== undefined ? '= ' + JSON.stringify(step.equals) : '⊇ ' + JSON.stringify(step.contains)}` };
    }
    case 'assertField': {
      // Assert any raw sgnodes field (the values `inspect` shows). attrs are strings, so compare as
      // strings — equals is exact, contains is a substring. Missing field ≠ empty: reported distinctly.
      let found = false, lastVal;
      const want = step.equals !== undefined ? String(step.equals) : String(step.contains);
      const ok = await pollUntil(async () => {
        const n = sel.matchOne((await sg.fetchTree(device, READ_OPTS)).roots, step.selector);
        if (!n) return null;
        found = true;
        const raw = n.attrs ? n.attrs[step.field] : undefined;
        lastVal = raw;
        if (raw === undefined) return null;
        return step.equals !== undefined ? (String(raw) === want ? n : null) : (String(raw).includes(want) ? n : null);
      }, { timeoutMs: stepTimeoutMs });
      if (!ok) {
        const wantMsg = step.equals !== undefined ? `equals ${JSON.stringify(want)}` : `contains ${JSON.stringify(want)}`;
        const got = !found ? 'node not found'
          : lastVal === undefined ? `field "${step.field}" not present`
          : `got ${JSON.stringify(lastVal)}`;
        throw new Error(`assertField ${sel.describe(step.selector)} ${step.field} ${wantMsg} — ${got}`);
      }
      return { detail: `${sel.describe(step.selector)} ${step.field} ${step.equals !== undefined ? '= ' : '⊇ '}${JSON.stringify(want)}` };
    }
    case 'assertLog':
      return logsLib.assertLog(ctx.logs, step.pattern, step.timeout ? step.timeout * 1000 : stepTimeoutMs);
    case 'expectNoLog':
      return logsLib.expectNoLog(ctx.logs, step.pattern);
    case 'assertState': {
      // Read the app's published state (__bt_state) and assert a value at `path`. Compares as strings so
      // equals is exact and contains is a substring — mirroring assertField/assertText.
      let present = false, lastVal;
      const want = step.equals !== undefined ? String(step.equals) : String(step.contains);
      const ok = await pollUntil(async () => {
        const res = appstate.extractAppState((await sg.fetchTree(device, READ_OPTS)).roots);
        if (!res.present || res.state == null) return null;
        present = true;
        const v = getPath(res.state, step.path);
        lastVal = v;
        if (v === undefined) return null;
        return step.equals !== undefined ? (String(v) === want ? true : null) : (String(v).includes(want) ? true : null);
      }, { timeoutMs: stepTimeoutMs });
      if (!ok) {
        const wantMsg = step.equals !== undefined ? `equals ${JSON.stringify(want)}` : `contains ${JSON.stringify(want)}`;
        const got = !present ? 'no app state published (app must mirror it into __bt_state — see BTState_publish)'
          : lastVal === undefined ? `path "${step.path}" not found`
          : `got ${JSON.stringify(lastVal)}`;
        throw new Error(`assertState ${step.path} ${wantMsg} — ${got}`);
      }
      return { detail: `${step.path} ${step.equals !== undefined ? '= ' : '⊇ '}${JSON.stringify(want)}` };
    }
    default:
      throw new Error(`unsupported step op: ${step.op}`);
  }
}

// Save a screenshot honoring --screenshots-mode. `when` is 'step' or 'failure'. `force` (an explicit
// `screenshot:` step the author asked for) captures in every mode except 'off'.
async function maybeScreenshot(ctx, flow, index, step, when, force = false) {
  const mode = ctx.opts.screenshotsMode || 'all';
  if (mode === 'off') return null;
  if (!force && mode === 'failure' && when !== 'failure') return null;
  if (!ctx.device.hasPassword) return null; // warned once in run()
  try {
    const { buffer, ext } = await ctx.device.screenshot();
    const dir = ctx.screenshotsDir;
    fs.mkdirSync(dir, { recursive: true });
    const label = step.op === 'screenshot' && step.name ? step.name.replace(/\.(png|jpg)$/i, '') : `${String(index + 1).padStart(2, '0')}-${step.op}`;
    // Namespace by run (matrix contentId / device) so parallel or matrix runs don't clobber each other.
    const runTag = ctx.runLabel ? `-${String(ctx.runLabel).replace(/[^\w.-]+/g, '_')}` : '';
    const file = path.join(dir, `${flow.name}${runTag}-${label}.${ext}`);
    fs.writeFileSync(file, buffer);
    return file;
  } catch (e) {
    return { error: e.message };
  }
}

// A failed step with log capture on: write the failure bundle (screenshot, tree, last N log lines, the error).
// A console crash (Brightscript Debugger> prompt) also gets a Home press so the next unit starts from Home.
async function failureBundle(ctx, flow, step, err, shot, write, c) {
  const crashed = ctx.logs.crash();
  if (crashed) {
    try { await ctx.device.keypress('Home'); await sleep(300); write('    ' + c.grey('sent Home to leave the debugger') + '\n'); }
    catch (e) { write('    ' + c.yellow(`Home recovery failed: ${e.message}`) + '\n'); }
  }
  const runTag = ctx.runLabel ? `-${String(ctx.runLabel).replace(/[^\w.-]+/g, '_')}` : '';
  try {
    const dir = await logsLib.writeFailureBundle(path.join(ctx.screenshotsDir, `${flow.name}${runTag}-failure`), { flow: flow.name, step, error: crashed ? new Error(`${err.message} (app crashed: ${crashed.summary})`) : err, logs: ctx.logs, shot, device: crashed ? null : ctx.device });
    write('    ' + c.grey('bundle: ' + path.relative(ctx.cfg.rootDir, dir)) + '\n');
  } catch (e) { write('    ' + c.yellow(`bundle failed: ${e.message}`) + '\n'); }
  if (crashed) ctx.logs.clearCrash();
}

// Run one flow file; emit a grouped ✓/✗ view through `write` (stdout live for one device, or a per-device
// buffer under parallelism). Returns { passed, failed, total }.
async function runFlow(flow, ctx, c, write) {
  const tag = ctx.runLabel ? c.grey(` [${ctx.runLabel}]`) : '';
  write('\n' + c.bold(flow.name) + tag + '  ' + c.grey(path.relative(ctx.cfg.rootDir, flow.file)) + '\n');
  let passed = 0, failed = 0;
  const frames = []; // captured screenshot paths, in order — assembled into a video if --video is set
  const collect = (shot) => { if (shot && typeof shot === 'string') frames.push(shot); return shot; };
  const logs = ctx.logs || null;
  if (logs) logs.beginFlow();
  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    const label = `${step.op}${step.op === 'screenshot' ? ` ${step.name}` : ''}`;
    try {
      if (logs && step.op === 'launch') logs.markLaunch();
      const { detail } = await execStep(step, ctx);
      if (logs && logs.crash()) throw new Error(`app crashed: ${logs.crash().summary}`);
      // Explicit `screenshot:` step captures regardless of mode (unless off); other steps follow the
      // per-mode filmstrip (all → every step; failure → none here).
      collect(await maybeScreenshot(ctx, flow, i, step, 'step', step.op === 'screenshot'));
      passed++;
      write('  ' + c.green('✓') + ' ' + c.dim(label) + (detail ? c.dim(` — ${detail}`) : '') + '\n');
    } catch (e) {
      failed++;
      write('  ' + c.red('✗ ' + label) + c.grey(`  (line ${step.line})`) + '\n');
      const crashed = logs && logs.crash();
      write('    ' + c.yellow(crashed && !/app crashed/.test(e.message) ? `${e.message} (app crashed: ${crashed.summary})` : e.message) + '\n');
      const shot = collect(await maybeScreenshot(ctx, flow, i, step, 'failure'));
      if (shot && typeof shot === 'string') write('    ' + c.grey('screenshot: ' + path.relative(ctx.cfg.rootDir, shot)) + '\n');
      if (logs) await failureBundle(ctx, flow, step, e, shot, write, c);
      break; // a flow stops at its first failing step (fail-fast within a flow)
    }
  }
  if (logs && (logs.connected || logs.all().length)) {
    const runTag = ctx.runLabel ? `-${String(ctx.runLabel).replace(/[^\w.-]+/g, '_')}` : '';
    try { logs.writeArtifact(path.join(ctx.screenshotsDir, `${flow.name}${runTag}.log`)); } catch (e) { /* best-effort */ }
  }
  if (ctx.opts.video && frames.length) {
    const { assembleVideo } = require('./video');
    const runTag = ctx.runLabel ? `-${String(ctx.runLabel).replace(/[^\w.-]+/g, '_')}` : '';
    const ext = ctx.opts.video === 'gif' ? 'gif' : 'mp4';
    const out = path.join(ctx.screenshotsDir, `${flow.name}${runTag}.${ext}`);
    const res = assembleVideo(frames, out);
    write(res.ok
      ? '  ' + c.dim(`🎞  video: ${path.relative(ctx.cfg.rootDir, out)} (${frames.length} frames)`) + '\n'
      : '  ' + c.yellow(`video skipped: ${res.reason}`) + '\n');
  }
  return { passed, failed, total: flow.steps.length };
}

// ---- run planning (pure) -----------------------------------------------------------------------

// Parse a --host value (or ROKU_HOST) into de-duped hosts plus a per-host dev password. Each entry may
// carry an inline password as `ip:pw` (IPv4 hosts have no colon of their own); a bare `ip` falls back to
// --password / ROKU_PASSWORD. Enables screenshots/video across devices with different dev passwords.
// Returns { hosts: string[], passwords: Map<host, password|null> }.
function parseTargets(opts) {
  const raw = opts.host || process.env.ROKU_HOST || '';
  const fallback = opts.password || process.env.ROKU_PASSWORD || null;
  const hosts = [];
  const passwords = new Map();
  for (const entry of String(raw).split(',').map((s) => s.trim()).filter(Boolean)) {
    const ci = entry.indexOf(':');
    const host = ci >= 0 ? entry.slice(0, ci).trim() : entry;
    const pw = ci >= 0 ? entry.slice(ci + 1) : null;
    if (!host) continue;
    if (!passwords.has(host)) hosts.push(host);
    passwords.set(host, pw || passwords.get(host) || fallback);
  }
  return { hosts, passwords };
}

// De-duped list of device hosts (without any inline password). Kept for callers/tests that only need hosts.
function parseHosts(opts) {
  return parseTargets(opts).hosts;
}

// Build the run plan: expand flows over the deep-link matrix (one unit per contentId, else one unit per
// flow), then round-robin the units across devices. Returns { units, byHost:Map<host, unit[]> } where a
// unit is { file, params, label }.
function buildPlan({ files, hosts, contentIds, mediaType }) {
  const units = [];
  for (const file of files) {
    if (contentIds && contentIds.length) {
      for (const cid of contentIds) {
        units.push({ file, params: { contentId: cid, ...(mediaType ? { mediaType } : {}) }, label: cid });
      }
    } else {
      units.push({ file, params: null, label: null });
    }
  }
  const byHost = new Map(hosts.map((h) => [h, []]));
  units.forEach((u, i) => byHost.get(hosts[i % hosts.length]).push(u));
  return { units, byHost };
}

// Run all of one device's units sequentially, emitting through `write`. Returns per-device stats.
// The device lease is held around all of this host's units (Home hygiene right after acquiring). Each host
// is an independent FIFO waiter, so sharded runs never hold one lease while waiting for another.
async function runHost(host, password, units, cfg, opts, c, write, multi, deps = {}) {
  const stats = { host, stepPass: 0, stepFail: 0, unitsFailed: 0, unitsTotal: units.length, aborted: false };
  const ecpPort = resolveEcpPort(opts.ecpPort);
  // Preflight, before the lease and its Home hygiene press: a read-only device-info GET. A Limited or
  // developer-disabled device fails here with the exact fix, before any launch or keypress.
  let bad;
  try { bad = await doctor.preflight((deps.createDevice || createDevice)({ host, password, ecpPort })); }
  catch (e) {
    if (!e || e.code !== 'DEVICE_UNREACHABLE') throw e;
    // Unreachable: fail this host only (other hosts keep running), with the reachable fix text.
    write(c.red(`\n[${host}] preflight failed: device not reachable.`) + '\n');
    write(c.yellow(`  reachable: ${e.fix}`) + '\n');
    stats.unitsFailed = units.length;
    return stats;
  }
  if (bad) {
    write(c.red(`\n[${host}] preflight failed: this device cannot run e2e flows.`) + '\n');
    for (const k of bad) write(c.yellow(`  ${k.id}: ${k.fix}`) + '\n');
    stats.unitsFailed = units.length;
    return stats;
  }
  const got = await (deps.acquireForLane || acquireForLane)({ cfg, opts, host, ecpPort, password, hygiene: true });
  if (got.code != null) { stats.unitsFailed = units.length; stats.leaseCode = got.code; return stats; }
  try { return await runHostUnits(stats, host, password, units, cfg, opts, c, write, multi, deps); }
  finally { if (got.lease) got.lease.release(); }
}

async function runHostUnits(stats, host, password, units, cfg, opts, c, write, multi, deps) {
  const device = (deps.createDevice || createDevice)({ host, password, ecpPort: resolveEcpPort(opts.ecpPort) });
  let info;
  try { info = await device.deviceInfo(); }
  catch (e) { write(c.red(`\n[${host}] ${e.message}`) + '\n'); stats.unitsFailed = units.length; return stats; }
  write(c.dim(`device: ${info.model || '?'} · fw ${info.firmware || '?'} · ${host}`) + '\n');
  if (!info.developerEnabled) write(c.yellow(`  warning: developer mode is not enabled on ${host}.`) + '\n');

  // One 8085 reader per device run, inside the lease. If it cannot connect (port busy, closed), the run goes on
  // without log capture; assertLog/expectNoLog then fail with the reason.
  const logPort = Number(opts.logPort || process.env.ROKU_LOG_PORT) || 0;
  let logs = null, logsOpened = false;
  try { return await runUnits(); } finally { if (logs) logs.close(); }

  async function runUnits() {
  const baseDir = opts.screenshots ? path.resolve(opts.screenshots) : path.resolve(cfg.stagingDir, 'e2e', 'screenshots');
  for (const unit of units) {
    let flow;
    try { flow = loadFlow(unit.file); }
    catch (e) {
      stats.unitsFailed++;
      write('\n' + c.red('✗ ' + path.basename(unit.file)) + (unit.label ? c.grey(` [${unit.label}]`) : '') +
        '\n    ' + c.yellow(e instanceof FlowError ? e.message : String(e.message)) + '\n');
      continue;
    }
    const ctx = makeCtx(device, cfg, opts, flow);
    if (!logsOpened && opts.logs !== false) { // opened on the first loadable flow, so a bad flow set never touches 8085
      logsOpened = true;
      logs = (deps.createLogs || logsLib.createLogs)(host, logPort ? { port: logPort } : {});
      await logs.connect();
    }
    ctx.logs = logs;
    ctx.launchParams = unit.params;
    ctx.runLabel = unit.label;
    ctx.screenshotsDir = multi ? path.join(baseDir, host.replace(/[^\w.-]+/g, '_')) : baseDir;
    try {
      const res = await runFlow(flow, ctx, c, write);
      stats.stepPass += res.passed; stats.stepFail += res.failed;
      if (res.failed) stats.unitsFailed++;
    } catch (e) {
      // Device-level error (Limited mode, unreachable mid-run): abort this device, keep the others.
      write('\n' + c.red(`[${host}] ${e.message}`) + '\n');
      stats.unitsFailed++; stats.stepFail++;
      if (e.code === 'LIMITED_MODE') { stats.aborted = true; return stats; }
    }
  }
  return stats;
  }
}

// ---- lane entry points -------------------------------------------------------------------------

async function run(cfg, opts, deps = {}) {
  const color = !!process.stdout.isTTY;
  const c = palette(color);
  const { hosts, passwords } = parseTargets(opts);
  if (!hosts.length) {
    process.stderr.write(c.red('[brighttest e2e] a device is required: --host <ip[:pw][,ip[:pw]…]> (or ROKU_HOST). Dev password enables screenshots.') + '\n');
    return 2;
  }
  try { resolveEcpPort(opts.ecpPort); }
  catch (e) { process.stderr.write(c.red(`[brighttest e2e] ${e.message}`) + '\n'); return 2; }

  // inspect/record are inherently single-device — use the first host.
  if (opts.e2eAction === 'inspect' || opts.e2eAction === 'record') {
    // A command lease for the whole call (no Home hygiene: inspect/record work on what is on screen).
    const ecpPort = resolveEcpPort(opts.ecpPort);
    const got = await (deps.acquireForLane || acquireForLane)({ cfg, opts, host: hosts[0], ecpPort, password: passwords.get(hosts[0]), hygiene: false });
    if (got.code != null) return got.code;
    try { return await inspectOrRecord(hosts[0], passwords.get(hosts[0]), cfg, opts, c, deps); }
    finally { if (got.lease) got.lease.release(); }
  }

  // --video is assembled from the per-step screenshots, so it needs capture on.
  if (opts.video && (opts.screenshotsMode || 'all') === 'off') {
    opts.screenshotsMode = 'all';
    process.stdout.write(c.dim('  note: --video needs screenshots; enabling --screenshots-mode all.') + '\n');
  }
  const mode = opts.screenshotsMode || 'all';
  const noPw = hosts.filter((h) => !passwords.get(h));
  if (mode !== 'off' && noPw.length) {
    const what = opts.video ? 'screenshots + video' : 'screenshots';
    process.stdout.write(c.yellow(`  note: no dev password for ${noPw.join(', ')} (use --host ip:pw); ${what} disabled there.`) + '\n');
  }

  let files;
  try { files = collectFlowFiles(opts.flows || []); }
  catch (e) { process.stderr.write(c.red(`[brighttest e2e] ${e.message}`) + '\n'); return 2; }
  if (!files.length) { process.stderr.write(c.red('[brighttest e2e] no flow files given (pass files or a directory of *.e2e.yaml)') + '\n'); return 2; }

  const plan = buildPlan({ files, hosts, contentIds: opts.contentIds, mediaType: opts.mediaType });
  const multi = hosts.length > 1;
  if (multi || (opts.contentIds && opts.contentIds.length)) {
    const matrixNote = opts.contentIds && opts.contentIds.length ? ` · matrix ${opts.contentIds.length} contentId(s)` : '';
    process.stdout.write(c.dim(`plan: ${plan.units.length} run(s) across ${hosts.length} device(s)${matrixNote}`) + '\n');
  }

  // One device per host, hosts in parallel. A single device streams live; multiple buffer per device and
  // flush in host order so the output stays readable.
  const tasks = hosts.map((host) => {
    const buf = [];
    const write = multi ? (s) => buf.push(s) : (s) => process.stdout.write(s);
    return runHost(host, passwords.get(host), plan.byHost.get(host), cfg, opts, c, write, multi, deps).then((stats) => ({ stats, buf }));
  });
  const results = await Promise.all(tasks);
  // Lease failures keep their own exit codes (75 busy/timeout, 77 lost, 78 lease dir) over the lane's 1.
  const leaseCode = results.map((r) => r.stats.leaseCode).find((x) => x != null);
  if (multi) for (const r of results) process.stdout.write('\n' + c.bold(`━━ ${r.stats.host} ━━`) + '\n' + r.buf.join(''));

  const stepPass = results.reduce((a, r) => a + r.stats.stepPass, 0);
  const stepFail = results.reduce((a, r) => a + r.stats.stepFail, 0);
  const unitsFailed = results.reduce((a, r) => a + r.stats.unitsFailed, 0);
  process.stdout.write('\n' + '─'.repeat(56) + '\n');
  const tally = `${c.green(stepPass + ' passed')}, ${stepFail ? c.red(stepFail + ' failed') : '0 failed'}`;
  process.stdout.write(`  brighttest (e2e): ${tally}${c.dim(` · ${plan.units.length} run(s) · ${hosts.length} device(s)`)}\n`);
  process.stdout.write('─'.repeat(56) + '\n');
  if (leaseCode != null) return leaseCode;
  return unitsFailed > 0 ? 1 : 0;
}

async function inspectOrRecord(host, password, cfg, opts, c, deps = {}) {
  const device = (deps.createDevice || createDevice)({ host, password, ecpPort: resolveEcpPort(opts.ecpPort) });
  let info;
  try { info = await device.deviceInfo(); }
  catch (e) { process.stderr.write(c.red(`[brighttest e2e] ${e.message}`) + '\n'); return 2; }
  process.stdout.write(c.dim(`device: ${info.model || '?'} · fw ${info.firmware || '?'} · ${host}`) + '\n');
  if (!info.developerEnabled) process.stdout.write(c.yellow('  warning: developer mode is not enabled on this device.') + '\n');
  if (opts.e2eAction === 'inspect') return inspect(device, cfg, opts, c);
  try { await require('./record').runRecord(device, opts); return 0; }
  catch (e) { process.stderr.write(c.red(`[brighttest e2e] ${e.message}`) + '\n'); return 2; }
}

// `e2e inspect` — dump a readable summary of the live tree to help authors find ids/text/subtypes.
async function inspect(device, cfg, opts, c) {
  if (opts.app) { try { await device.launch(opts.app); await waitForChannel(device); await sg.waitForSettle(device); } catch (e) { /* fall through to read */ } }
  let tree;
  try { tree = await sg.fetchTree(device, READ_OPTS); }
  catch (e) {
    process.stderr.write(c.red(`[brighttest e2e] ${e.message}`) + '\n');
    if (e.code === 'CHANNEL_NOT_RUNNING') process.stderr.write(c.dim('  tip: pass --app dev to launch first.') + '\n');
    return 2;
  }
  const all = sg.flatten(tree.roots);
  // A selector (--id/--text/--subtype/…) switches inspect from the tree summary to a per-node detail view:
  // dump every field of the matched node(s) and generate ready-to-paste assertions from their actual state.
  const selector = opts.sel && Object.keys(opts.sel).length ? opts.sel : null;
  if (selector) return inspectNodes(tree.roots, selector, opts, c);

  const bySubtype = {};
  const ids = [];
  const focused = [];
  const texts = [];
  for (const n of all) {
    bySubtype[n.subtype] = (bySubtype[n.subtype] || 0) + 1;
    if (n.id === appstate.STATE_NODE_ID) continue; // the state mirror is inspected on its own, below
    if (n.id) ids.push(n.id);
    if (n.focused) focused.push(`${n.subtype}#${n.id || '(no id)'}${n.text ? ` "${n.text}"` : ''}`);
    if (n.text) texts.push(n.text);
  }
  process.stdout.write('\n' + c.bold(`Live tree: ${all.length} nodes, ${Object.keys(bySubtype).length} subtypes`) + '\n');
  const top = Object.entries(bySubtype).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([t, n]) => `${t}×${n}`);
  process.stdout.write(c.dim('  subtypes: ') + top.join(', ') + '\n');
  process.stdout.write(c.dim(`  ids (name=): ${ids.length ? [...new Set(ids)].slice(0, 25).join(', ') : '(none — selectors must use text/subtype)'}`) + '\n');
  process.stdout.write(c.dim('  focused: ') + (focused.join(' | ') || '(none)') + '\n');
  process.stdout.write(c.dim('  sample text: ') + ([...new Set(texts)].slice(0, 12).map((t) => JSON.stringify(t)).join(', ') || '(none)') + '\n');
  printAppState(appstate.extractAppState(tree.roots), c);
  return 0;
}

// Print the app's self-published state snapshot (m.global + whatever it mirrors into __bt_state). Absent
// unless the app opts in via BTState_publish — so silence when there's nothing to show, a hint on bad JSON.
function printAppState(res, c) {
  if (!res.present) return;
  if (res.error) {
    process.stdout.write('\n' + c.bold('App state') + c.dim(` (${appstate.STATE_NODE_ID})`) + '\n');
    process.stdout.write(c.red(`  unreadable: ${res.error}`) + '\n');
    return;
  }
  process.stdout.write('\n' + c.bold('App state') + c.dim(` (${appstate.STATE_NODE_ID})`) + '\n');
  for (const line of JSON.stringify(res.state, null, 2).split('\n')) {
    process.stdout.write('  ' + line + '\n');
  }
}

// `e2e inspect <selector>` — per-node detail. Dumps every field of the matched node(s) so an author can
// verify what to assert on, then prints (and optionally appends) assertions built from the node's state.
// `roots` is the parsed tree (matchAll flattens it itself; passing an already-flattened list would visit
// every nested node once per ancestor and report it several times).
function inspectNodes(roots, selector, opts, c) {
  const all = sg.flatten(roots);
  let matched;
  try { matched = sel.matchAll(roots, selector); }
  catch (e) { process.stderr.write(c.red(`[brighttest e2e] ${e.message}`) + '\n'); return 2; }
  if (!matched.length) {
    process.stdout.write('\n' + c.yellow(`No node matched ${sel.describe(selector)}.`) + '\n');
    process.stdout.write(c.dim('  Run `e2e inspect` with no selector to list the ids / subtypes on screen.') + '\n');
    return 2;
  }
  process.stdout.write('\n' + c.bold(`${matched.length} node(s) matched ${sel.describe(selector)}`) + '\n');
  for (const node of matched) printNodeDetail(node, all, c);
  // ECP serializes only built-in SceneGraph fields: custom interface fields and m.global never appear above.
  process.stdout.write('\n' + c.dim('  note: custom interface fields and m.global are not visible over ECP; only built-in fields are listed.') + '\n');
  const st = appstate.extractAppState(roots);
  if (st.present) printAppState(st, c);
  else process.stdout.write(c.dim(`  To inspect app state, publish it with BTState_publish (hidden node #${appstate.STATE_NODE_ID}).`) + '\n');

  if (opts.out) {
    const kind = opts.assert || 'visible';
    if (matched.length > 1) {
      process.stdout.write('\n' + c.yellow(`  note: ${matched.length} nodes matched — appending for the first. Narrow the selector (or add --index) to target another.`) + '\n');
    }
    let line;
    try { line = ab.buildAssertion(kind, matched[0], all, { field: opts.field }); }
    catch (e) { process.stderr.write(c.red(`[brighttest e2e] ${e.message}`) + '\n'); return 2; }
    try {
      const res = ab.appendAssertion(opts.out, line, { appId: opts.app || 'dev' });
      process.stdout.write(c.green(`  ${res.created ? 'created' : 'appended to'} ${opts.out}`) + c.dim(`  ${line}`) + '\n');
    } catch (e) {
      process.stderr.write(c.red(`[brighttest e2e] append failed: ${e.message}`) + '\n');
      return 2;
    }
  } else {
    process.stdout.write('\n' + c.dim('  tip: add --out flows/x.e2e.yaml [--assert visible|text|focused|gone|field --field <name>] to append one.') + '\n');
  }
  return 0;
}

function printNodeDetail(node, all, c) {
  const label = `${node.subtype}${node.id ? ' #' + node.id : ''}${node.text ? ` "${node.text}"` : ''}`;
  process.stdout.write('\n' + c.bold('Node  ') + label + '\n');
  const attrs = node.attrs || {};
  const keys = Object.keys(attrs);
  process.stdout.write(c.dim('  fields (all sgnodes attrs):') + '\n');
  if (!keys.length) process.stdout.write('    (no attributes dumped)\n');
  const width = keys.reduce((w, k) => Math.max(w, k.length), 4);
  for (const k of keys) process.stdout.write(`    ${k.padEnd(width)} = ${attrs[k]}\n`);

  const kids = node.children || [];
  const descendants = sg.flatten(kids).length;
  const kidNote = kids.length && descendants !== kids.length ? `${kids.length} direct (${descendants} total)` : String(kids.length);
  process.stdout.write(c.dim(`  children: ${kidNote}`) + '\n');

  const s = ab.suggestSelector(node, all);
  const matchNote = s.count === 1
    ? 'unique (1 node)'
    : `${s.count} nodes share this selector — disambiguated with index: ${s.index}`;
  process.stdout.write(c.dim(`  match: ${matchNote}`) + '\n');
  process.stdout.write('\n' + c.dim('  Suggested assertions (copy into a flow):') + '\n');
  for (const l of ab.displayAssertions(node, all)) process.stdout.write('    ' + l + '\n');
}

module.exports = { inspectNodes, run, execStep, resolveTarget, pollUntil: pollUntilBase, guardDevice, parseHosts, parseTargets, buildPlan };
