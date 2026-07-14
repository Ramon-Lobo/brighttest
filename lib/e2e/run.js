'use strict';
const fs = require('fs');
const path = require('path');
const { palette } = require('../reporter');
const { createDevice } = require('./ecp');
const sg = require('./sgnodes');
const sel = require('./select');
const nav = require('./navigate');
const { loadFlow, collectFlowFiles, FlowError } = require('./flow');

// The `brighttest e2e` lane: drive a flow file on a real Roku over ECP and assert on the live SceneGraph
// tree. Deterministic and author-first — no model in the loop. Reuses the reporter palette for a grouped
// ✓/✗ view consistent with the other lanes. See design/e2e-lane.md.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve the device target from flags, falling back to ROKU_HOST/ROKU_PASSWORD (same convention the
// --device lane documents).
function resolveTarget(opts) {
  return {
    host: opts.host || process.env.ROKU_HOST || null,
    password: opts.password || process.env.ROKU_PASSWORD || null,
  };
}

// Poll `fn` until it returns a truthy value or the timeout elapses. Returns the value or null.
async function pollUntil(fn, { timeoutMs, intervalMs = 250 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

// After launch, sgnodes reports "Channel not running" until the scene is up — wait it out.
async function waitForChannel(device, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return await sg.fetchTree(device); }
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
  switch (step.op) {
    case 'launch': {
      const appId = ctx.opts.app || ctx.flow.appId || 'dev';
      await device.launch(appId, step.params || {});
      await waitForChannel(device);
      await sg.waitForSettle(device);
      return { detail: appId + (Object.keys(step.params || {}).length ? ' (deep link)' : '') };
    }
    case 'press':
      await device.keypressSeq(step.key, step.count);
      await sg.waitForSettle(device);
      return { detail: step.count > 1 ? `${step.key} ×${step.count}` : step.key };
    case 'back':
      await device.keypress('Back'); await sg.waitForSettle(device); return { detail: 'Back' };
    case 'home':
      await device.keypress('Home'); await sleep(800); return { detail: 'Home' };
    case 'screenshot':
      // The capture itself is driven by runFlow()/maybeScreenshot() (it honors --screenshots-mode and
      // needs the flow/index context); here the step is just a settled marker.
      return { detail: step.name };
    case 'text':
      await device.text(step.value); await sg.waitForSettle(device); return { detail: JSON.stringify(step.value) };
    case 'focus': {
      const { presses } = await nav.focusTo(device, step.selector, { maxPresses: step.maxPresses });
      return { detail: `${sel.describe(step.selector)} (${presses} press${presses === 1 ? '' : 'es'})` };
    }
    case 'pressUntil': {
      for (let i = 0; i < step.max; i++) {
        const tree = await sg.fetchTree(device);
        if (sel.matchOne(tree.roots, step.selector)) return { detail: `${sel.describe(step.selector)} after ${i} press(es)` };
        await device.keypress(step.key);
        await sg.waitForSettle(device);
      }
      const tree = await sg.fetchTree(device);
      if (sel.matchOne(tree.roots, step.selector)) return { detail: `${sel.describe(step.selector)} after ${step.max} press(es)` };
      throw new Error(`pressUntil: ${sel.describe(step.selector)} not visible after ${step.max}× ${step.key}`);
    }
    case 'assertVisible':
    case 'waitFor': {
      const timeout = step.timeout ? step.timeout * 1000 : stepTimeoutMs;
      const found = await pollUntil(async () => sel.matchOne((await sg.fetchTree(device)).roots, step.selector), { timeoutMs: timeout });
      if (!found) throw new Error(`${sel.describe(step.selector)} not visible within ${timeout / 1000}s`);
      return { detail: sel.describe(step.selector) };
    }
    case 'assertGone': {
      const gone = await pollUntil(async () => (sel.matchOne((await sg.fetchTree(device)).roots, step.selector) ? false : true), { timeoutMs: stepTimeoutMs });
      if (!gone) throw new Error(`${sel.describe(step.selector)} still visible after ${stepTimeoutMs / 1000}s`);
      return { detail: sel.describe(step.selector) };
    }
    case 'assertFocused': {
      const ok = await pollUntil(async () => {
        const n = sel.matchOne((await sg.fetchTree(device)).roots, step.selector);
        return n && n.focused ? n : null;
      }, { timeoutMs: stepTimeoutMs });
      if (!ok) throw new Error(`${sel.describe(step.selector)} not focused within ${stepTimeoutMs / 1000}s`);
      return { detail: sel.describe(step.selector) };
    }
    case 'assertText': {
      let lastText = null;
      const ok = await pollUntil(async () => {
        const n = sel.matchOne((await sg.fetchTree(device)).roots, step.selector);
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
    const file = path.join(dir, `${flow.name}-${label}.${ext}`);
    fs.writeFileSync(file, buffer);
    return file;
  } catch (e) {
    return { error: e.message };
  }
}

// Run one flow file; stream ✓/✗ per step. Returns { passed, failed, steps }.
async function runFlow(flow, ctx, c) {
  process.stdout.write('\n' + c.bold(flow.name) + '  ' + c.grey(path.relative(ctx.cfg.rootDir, flow.file)) + '\n');
  let passed = 0, failed = 0;
  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    const label = `${step.op}${step.op === 'screenshot' ? ` ${step.name}` : ''}`;
    try {
      const { detail } = await execStep(step, ctx);
      // Explicit `screenshot:` step captures regardless of mode (unless off); other steps follow the
      // per-mode filmstrip (all → every step; failure → none here).
      await maybeScreenshot(ctx, flow, i, step, 'step', step.op === 'screenshot');
      passed++;
      process.stdout.write('  ' + c.green('✓') + ' ' + c.dim(label) + (detail ? c.dim(` — ${detail}`) : '') + '\n');
    } catch (e) {
      failed++;
      process.stdout.write('  ' + c.red('✗ ' + label) + c.grey(`  (line ${step.line})`) + '\n');
      process.stdout.write('    ' + c.yellow(e.message) + '\n');
      const shot = await maybeScreenshot(ctx, flow, i, step, 'failure');
      if (shot && typeof shot === 'string') process.stdout.write('    ' + c.grey('screenshot: ' + path.relative(ctx.cfg.rootDir, shot)) + '\n');
      break; // a flow stops at its first failing step (fail-fast within a flow)
    }
  }
  return { passed, failed, total: flow.steps.length };
}

// ---- lane entry points -------------------------------------------------------------------------

async function run(cfg, opts) {
  const color = !!process.stdout.isTTY;
  const c = palette(color);
  const { host, password } = resolveTarget(opts);
  if (!host) {
    process.stderr.write(c.red('[brighttest e2e] a device is required: --host <ip> (or ROKU_HOST). Dev --password enables screenshots.') + '\n');
    return 2;
  }
  const device = createDevice({ host, password });

  // Preflight: reachable + dev mode.
  let info;
  try { info = await device.deviceInfo(); }
  catch (e) { process.stderr.write(c.red(`[brighttest e2e] ${e.message}`) + '\n'); return 2; }
  process.stdout.write(c.dim(`device: ${info.model || '?'} · fw ${info.firmware || '?'} · ${host}`) + '\n');
  if (!info.developerEnabled) process.stdout.write(c.yellow('  warning: developer mode is not enabled on this device.') + '\n');

  if (opts.e2eAction === 'inspect') return inspect(device, cfg, opts, c);
  if (opts.e2eAction === 'record') {
    try { await require('./record').runRecord(device, opts); return 0; }
    catch (e) { process.stderr.write(c.red(`[brighttest e2e] ${e.message}`) + '\n'); return 2; }
  }

  const mode = opts.screenshotsMode || 'all';
  if (mode !== 'off' && !password) {
    process.stdout.write(c.yellow(`  note: --screenshots-mode ${mode} needs a dev --password; screenshots disabled for this run.`) + '\n');
  }

  let files;
  try { files = collectFlowFiles(opts.flows || []); }
  catch (e) { process.stderr.write(c.red(`[brighttest e2e] ${e.message}`) + '\n'); return 2; }
  if (!files.length) { process.stderr.write(c.red('[brighttest e2e] no flow files given (pass files or a directory of *.e2e.yaml)') + '\n'); return 2; }

  let totalPass = 0, totalFail = 0, flowsFailed = 0;
  for (const file of files) {
    let flow;
    try { flow = loadFlow(file); }
    catch (e) {
      flowsFailed++;
      process.stderr.write('\n' + c.red('✗ ' + path.basename(file)) + '\n    ' + c.yellow(e instanceof FlowError ? e.message : String(e.message)) + '\n');
      continue;
    }
    const ctx = makeCtx(device, cfg, opts, flow);
    ctx.screenshotsDir = opts.screenshots ? path.resolve(opts.screenshots) : path.resolve(cfg.stagingDir, 'e2e', 'screenshots');
    let res;
    try { res = await runFlow(flow, ctx, c); }
    catch (e) {
      // A device-level error (Limited mode, unreachable mid-run) aborts the whole run with guidance.
      process.stderr.write('\n' + c.red(`[brighttest e2e] ${e.message}`) + '\n');
      if (e.code === 'LIMITED_MODE') return 2;
      flowsFailed++; totalFail++; continue;
    }
    totalPass += res.passed; totalFail += res.failed;
    if (res.failed) flowsFailed++;
  }

  process.stdout.write('\n' + '─'.repeat(56) + '\n');
  const tally = `${c.green(totalPass + ' passed')}, ${totalFail ? c.red(totalFail + ' failed') : '0 failed'}`;
  process.stdout.write(`  brighttest (e2e): ${tally}${c.dim(` · ${files.length} flow(s)`)}\n`);
  process.stdout.write('─'.repeat(56) + '\n');
  return flowsFailed > 0 ? 1 : 0;
}

// `e2e inspect` — dump a readable summary of the live tree to help authors find ids/text/subtypes.
async function inspect(device, cfg, opts, c) {
  if (opts.app) { try { await device.launch(opts.app); await waitForChannel(device); await sg.waitForSettle(device); } catch (e) { /* fall through to read */ } }
  let tree;
  try { tree = await sg.fetchTree(device); }
  catch (e) {
    process.stderr.write(c.red(`[brighttest e2e] ${e.message}`) + '\n');
    if (e.code === 'CHANNEL_NOT_RUNNING') process.stderr.write(c.dim('  tip: pass --app dev to launch first.') + '\n');
    return 2;
  }
  const all = sg.flatten(tree.roots);
  const bySubtype = {};
  const ids = [];
  const focused = [];
  const texts = [];
  for (const n of all) {
    bySubtype[n.subtype] = (bySubtype[n.subtype] || 0) + 1;
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
  return 0;
}

module.exports = { run, execStep, resolveTarget, pollUntil };
