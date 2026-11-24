'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { writeBsConfig } = require('./config');
const { engineBin, engineFor, supportsFlag } = require('./engines');
const { palette, makeReporter, lineSplitter, printFailures, laneFailures, deviceLabel } = require('./reporter');

// Extract a clean lcov.info from Rooibos's console output (printLcov=true prints TN:/SF:/DA:/LF:/LH:/
// end_of_record blocks verbatim). Framework-injected records (…/rooibos/…) are dropped.
function extractLcov(output) {
  const records = [];
  let cur = [];
  let sf = null;
  let inRec = false;
  for (const raw of output.split(/\r\n|\r|\n/)) {
    // Strip ANSI escapes before parsing: brs-node colorizes parts of the coverage output (e.g. the
    // ".brs" file extension in SF: paths, and numbers in DA:/LF:/LH: lines). Left in, the escapes
    // corrupt SF: paths in the emitted lcov.info (breaking Coveralls/Codecov/genhtml) and make the
    // strict DA:/LF:/LH: regexes below miss colorized lines, silently dropping real coverage data.
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (line === 'TN:') { cur = ['TN:']; sf = null; inRec = true; continue; }
    if (!inRec) {
      if (line.startsWith('SF:')) { cur = ['TN:', line]; sf = line.slice(3); inRec = true; }
      continue;
    }
    if (line.startsWith('SF:')) { sf = line.slice(3); cur.push(line); continue; }
    if (/^DA:\d+,\d+$/.test(line) || /^LF:\d+$/.test(line) || /^LH:\d+$/.test(line)) { cur.push(line); continue; }
    if (line === 'end_of_record') {
      cur.push('end_of_record');
      if (sf && !/(^|\/)rooibos\//.test(sf)) records.push(cur.join('\n'));
      cur = []; sf = null; inRec = false;
    }
  }
  return { text: records.length ? records.join('\n') + '\n' : '', count: records.length };
}

// Start the Rooibos device CLI: under a held lease it runs in its own process group and is recorded in the
// lease (childPids), so a crash of this process never leaves it running unaccounted for.
function startRooibos(args, lease, spawnFn) {
  const o = { stdio: ['ignore', 'pipe', 'pipe'] };
  if (lease && !spawnFn) return lease.spawn(process.execPath, args, o);
  const child = (spawnFn || spawn)(process.execPath, args, o);
  if (lease && child && child.pid) lease.addChild(child.pid);
  return child;
}
function killTree(child) {
  try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
  catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
}

// Best-effort single Home before deploy so the app under test starts from a clean launcher (a channel
// left running makes the CLI's deploy/app-exit race). A failure never fails the run. Returns the error or null.
async function homeBeforeDeploy(opts, deps = {}) {
  const make = deps.createDevice || require('./e2e/ecp').createDevice;
  const wait = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  try {
    await make({ host: opts.host, password: opts.password, ecpPort: opts.ecpPort }).keypress('Home');
    await wait(deps.settleMs != null ? deps.settleMs : 1000);
    return null;
  } catch (e) { return e; }
}

// Read lcov.info written by the rooibos CLI's --coverage-dir, through extractLcov (drops framework records).
function readCoverageDir(dir) {
  try { return extractLcov(fs.readFileSync(path.join(dir, 'lcov.info'), 'utf8')); }
  catch { return { text: '', count: 0 }; }
}

// Take the device lease for a lane (null when bypassed); returns { lease } or { code }.
function leaseFor(cfg, opts, deps, pool) {
  const acquireForLane = deps.acquireForLane || require('./device-command').acquireForLane;
  if (pool) return acquireForLane({ cfg, opts, pool });
  return acquireForLane({ cfg, opts, host: opts.host, password: opts.password });
}

// Header line for the lane. Labelled with what the lane knows (host, plus model/firmware when supplied via
// deps.deviceInfo); never the serial or any credential. An empty label keeps the original text.
function laneHeader(opts, deps = {}) {
  const di = deps.deviceInfo || {};
  const label = deviceLabel({ host: opts.host, model: di.model, softwareVersion: di.softwareVersion, build: di.build });
  return label ? `  building, deploying to ${label}, and running…` : '  building, deploying to the device, and running…';
}

// Device lane: build with coverage ON, deploy via the stock Rooibos CLI, and run on hardware — streaming
// the same grouped, Jest-style view + failure summary as the headless lanes (Rooibos emits identical
// console markers on device). The Rooibos device CLI self-exits when the run finishes, so we resolve on
// close, guarded by a watchdog timeout.
async function run(cfg, opts, deps = {}) {
  const dc = require('./device-command');
  // `--device any` (no explicit host): the pool is picked at the lease below; the host and password follow from it.
  const pf = dc.poolForLane(cfg, opts);
  if (pf.code != null) return pf.code;
  const pool = pf.pool;
  let poolGot = null;
  if (pool) {
    const bad = dc.poolPreflight(pool, opts);
    if (bad) { console.error(`[brighttest] ${bad}`); return 2; }
    poolGot = await leaseFor(cfg, opts, deps, pool);
    if (poolGot.code != null) return poolGot.code;
    const r = dc.resolveLaneOpts({ ...opts, host: poolGot.host });
    if (!r) { if (poolGot.lease) poolGot.lease.release(); console.error('[brighttest] --device any: no dev password for the chosen device'); return 2; }
    opts = r;
  } else {
    const ambiguous = dc.ambiguousHostMessage(opts);
    if (ambiguous) {
      console.error(`[brighttest] --device: ${ambiguous}`);
      return 2;
    }
    const resolved = dc.resolveLaneOpts(opts);
    if (!resolved) {
      console.error('[brighttest] --device requires --host <ip> and --password <dev-password> (or ROKU_HOST / ROKU_PASSWORD)');
      return 2;
    }
    opts = resolved;
  }
  // A throw while setting up the run (config, engine) must not leave the pool lease held.
  try { return await runLane(cfg, opts, deps, poolGot); }
  catch (e) { if (poolGot && poolGot.lease) poolGot.lease.release(); throw e; }
}

async function runLane(cfg, opts, deps, poolGot) {
  const { bsconfigPath } = writeBsConfig(cfg, 'device', { lcov: !!opts.lcov });
  const rooibos = engineBin('rooibos', cfg);
  const args = [rooibos, `--project=${bsconfigPath}`, `--host=${opts.host}`, `--password=${opts.password}`];
  // --coverage-dir is the fallback source when the console lcov is empty; pass it only when the engine has it.
  let coverageDir = null;
  if (opts.lcov) {
    let supported = false;
    try { supported = supportsFlag((deps.engineFor || engineFor)('rooibos', cfg), 'coverage-dir'); } catch { /* unresolved: no flag */ }
    if (supported) {
      coverageDir = path.join(cfg.stagingDir, 'device', 'coverage');
      fs.rmSync(coverageDir, { recursive: true, force: true });
      args.push(`--coverage-dir=${coverageDir}`);
    }
  }
  // Idle watchdog: CLI flag (opts.idleTimeout), then config (deviceIdleTimeout), then DEFAULT_IDLE_S. Only an explicit
  // value is passed on to the rooibos CLI; unset leaves its argv unchanged.
  if (opts.idleTimeout == null && cfg.deviceIdleTimeout != null) opts = { ...opts, idleTimeout: cfg.deviceIdleTimeout };
  if (opts.idleTimeout != null) {
    args.push(`--idle-timeout=${opts.idleTimeout}`);
  }
  const color = !!process.stdout.isTTY;
  const reporter = makeReporter(cfg, color);
  const splitter = lineSplitter(reporter.onLine);
  const timeoutMs = (opts.timeout || 900) * 1000; // default 15 min

  const got = poolGot || await leaseFor(cfg, opts, deps);
  if (got.code != null) return got.code;
  const lease = got.lease;

  try {
    const err = await (deps.homeBeforeDeploy || homeBeforeDeploy)(opts, deps);
    if (err) process.stderr.write(`[brighttest] warning: Home before deploy failed (${err.message}); continuing\n`);
  } catch (e) { process.stderr.write(`[brighttest] warning: Home before deploy failed (${e.message}); continuing\n`); }

  process.stdout.write(palette(color).dim(laneHeader(opts, deps)) + '\n');
  try {
    return await new Promise((resolve) => {
      let out = '';
      let didTimeout = false;
      let didIdle = false;
      let settled = false;
      const idleSecs = opts.idleTimeout != null ? opts.idleTimeout : DEFAULT_IDLE_S;
      let idleTimer = null;
      const armIdle = () => {
        if (!(idleSecs > 0)) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          didIdle = true;
          killTree(child);
          setTimeout(done, deps.killGraceMs != null ? deps.killGraceMs : 2000).unref();
        }, idleSecs * 1000);
      };
      const child = startRooibos(args, lease, deps.spawn);
      armIdle();
      // The periodic "channel: mem=..." heartbeat is not progress: a chunk of only those lines does not re-arm idle.
      const onData = (buf) => { const s = buf.toString(); out += s; splitter.push(s); if (!isHeartbeatOnly(s)) armIdle(); };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      // Watchdog: no result by the deadline is a failure. Kill the process group, and do not depend on the
      // child ever emitting 'close' (a wedged child would otherwise hang the lane while holding the lease).
      const timer = setTimeout(() => {
        didTimeout = true;
        killTree(child);
        setTimeout(done, deps.killGraceMs != null ? deps.killGraceMs : 2000).unref();
      }, timeoutMs);
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(idleTimer);
        splitter.flush();
        resolve(finishDevice(cfg, opts, out, reporter.state, color, didTimeout, coverageDir, didIdle));
      };
      child.on('close', done);
      child.on('error', done);
    });
  } finally {
    if (lease) lease.release();
  }
}

// Markers taken from real fw 16.0.4 output (ENG-T14-DQ cases b, c): the rooibos CLI prints
// "[roku-test] no device output for <N>s — run stalled" when the device goes silent, and a BrightScript
// runtime error drops the device into the "Brightscript Debugger>" prompt. The device never printed a
// separate "Runtime Error" line into the captured stream, so the prompt is the only marker used.
// True when every non-blank line is a channel memory heartbeat (and there is at least one).
function isHeartbeatOnly(s) {
  const lines = s.split(/\r?\n/).filter((l) => l.trim() !== '');
  return lines.length > 0 && lines.every((l) => /^channel: mem=/.test(l));
}

// Lane-side idle (output-silence) watchdog default, seconds. Above the rooibos CLI's own 90s stall exit so the
// CLI's typed line wins when it works; this is the backstop when the CLI wedges silently. opts.idleTimeout overrides.
const DEFAULT_IDLE_S = 120;
const STALL_RE = /\[roku-test\] no device output for (\d+)s/;
const DEBUGGER_RE = /Brightscript Debugger>/i;

// Typed reason for a run that produced no [Rooibos Result], or null when no known marker is present.
function abortReason(out, state, idleSecs) {
  if (DEBUGGER_RE.test(out)) {
    return `run aborted by runtime error in ${state.suite || 'unknown suite (no suite header in the output)'}`;
  }
  const m = STALL_RE.exec(out);
  if (m) return `run aborted: no device output for ${m[1]}s (idle watchdog)`;
  if (idleSecs != null) return `run aborted: no device output for ${idleSecs}s (idle watchdog)`;
  return null;
}

// Print the failure summary + totals, write LCOV (when requested), return an exit code. Per-test ✓/✗ were
// already streamed live by the reporter; this adds the end-of-run summary.
function finishDevice(cfg, opts, out, state, color, didTimeout, coverageDir, didIdle) {
  const c = palette(color);
  const cases = state.cases;
  const { passed: streamedPassed } = state;
  const { failed, summary } = laneFailures(out, state.failed);
  const passed = summary ? Math.max(summary.passed, streamedPassed) : streamedPassed;
  // Streamed cases alone are not a result: a run that dies mid-way never printed [Rooibos Result].
  const sawResult = /\[Rooibos Result\]/.test(out);

  printFailures(cfg, out, cases, color);

  let lcovNote = '';
  let covNote = '';
  if (opts.lcov) {
    let { text, count } = extractLcov(out);
    if (!text && coverageDir) ({ text, count } = readCoverageDir(coverageDir));
    if (text) {
      const dest = path.resolve(opts.lcov);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, text);
      lcovNote = ` · LCOV: ${opts.lcov} (${count} records)`;
      const { printCoverageTable } = require('./coverage-report');
      const overallPct = printCoverageTable(text, cfg, color);
      if (overallPct != null) covNote = ` · lines ${overallPct.toFixed(2)}%`;
    }
  }

  process.stdout.write('\n' + '─'.repeat(56) + '\n');
  if (didTimeout) {
    process.stderr.write('  ' + c.red(`brighttest (device): TIMED OUT after ${opts.timeout || 900}s — a node test may never have signalled completion (m.done()?), or the device was unreachable.`) + '\n');
    process.stdout.write('─'.repeat(56) + '\n');
    return 1;
  }
  // An idle kill is a failure even if a result line streamed earlier (the run did not finish cleanly).
  if (!sawResult || didIdle) {
    const why = abortReason(out, state, didIdle ? opts.idleTimeout != null ? opts.idleTimeout : DEFAULT_IDLE_S : null);
    const head = why ? `${why} (no [Rooibos Result] line). Output tail:` : 'no results — deploy or device error. Output tail:';
    process.stderr.write('  ' + c.red('brighttest (device): ' + head) + '\n');
    process.stderr.write(out.split(/\r\n|\r|\n/).slice(-25).join('\n') + '\n');
    process.stdout.write('─'.repeat(56) + '\n');
    return 1;
  }
  if (opts.lcov && !lcovNote) {
    process.stderr.write('  ' + c.red('brighttest (device): --lcov requested but no coverage was returned (empty console lcov' + (coverageDir ? ' and no lcov.info in --coverage-dir' : '') + '; is coverage on and did tests run?)') + '\n');
    process.stdout.write('─'.repeat(56) + '\n');
    return 1;
  }
  const suitesRun = new Set(cases.map((t) => t.suite).filter(Boolean)).size;
  const suitesNote = suitesRun ? c.dim(` · ${suitesRun} suites`) : '';
  const tally = `${c.green(passed + ' passed')}, ${failed ? c.red(failed + ' failed') : failed + ' failed'}`;
  process.stdout.write(`  brighttest (device): ${tally}${suitesNote}${c.dim(covNote)}${c.dim(lcovNote)}\n`);
  process.stdout.write('─'.repeat(56) + '\n');
  return failed > 0 ? 1 : 0;
}

// Build + run on the device, capturing raw Rooibos output (used by the cross-check lane, which does its
// own diff/summary — no streaming here). Async (never spawnSync): the lease heartbeat and deadline timers
// must keep running while the device phase is in progress. The caller holds the lease (`deps.lease`).
function buildAndRun(cfg, opts, deps = {}) {
  const { bsconfigPath } = writeBsConfig(cfg, 'device', { lcov: false });
  const rooibos = engineBin('rooibos', cfg);
  const args = [rooibos, `--project=${bsconfigPath}`, `--host=${opts.host}`, `--password=${opts.password}`];
  const timeoutMs = (opts.timeout || 900) * 1000;
  const MAX = 64 * 1024 * 1024;
  return new Promise((resolve) => {
    const chunks = { out: [], err: [] };
    let size = 0;
    let didTimeout = false;
    let settled = false;
    const child = startRooibos(args, deps.lease, deps.spawn);
    const keep = (k) => (buf) => { if (size < MAX) { chunks[k].push(buf); size += buf.length; } };
    child.stdout.on('data', keep('out'));
    child.stderr.on('data', keep('err'));
    const timer = setTimeout(() => { didTimeout = true; killTree(child); }, timeoutMs);
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = (k) => Buffer.concat(chunks[k].map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c))))).toString('utf8');
      resolve({ output: text('out') + text('err'), status: didTimeout ? null : status, timedOut: didTimeout });
    };
    child.on('close', (code) => finish(code));
    child.on('error', () => finish(null));
  });
}

module.exports = { laneHeader, run, extractLcov, buildAndRun, homeBeforeDeploy, readCoverageDir };
