'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { writeBsConfig } = require('./config');
const { resolveBin } = require('./tools');
const { palette, makeReporter, lineSplitter, printFailures } = require('./reporter');

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

// Take the device lease for a lane (null when bypassed); returns { lease } or { code }.
function leaseFor(cfg, opts, deps) {
  const acquireForLane = deps.acquireForLane || require('./device-command').acquireForLane;
  return acquireForLane({ cfg, opts, host: opts.host, password: opts.password });
}

// Device lane: build with coverage ON, deploy via the stock Rooibos CLI, and run on hardware — streaming
// the same grouped, Jest-style view + failure summary as the headless lanes (Rooibos emits identical
// console markers on device). The Rooibos device CLI self-exits when the run finishes, so we resolve on
// close, guarded by a watchdog timeout.
async function run(cfg, opts, deps = {}) {
  const ambiguous = require('./device-command').ambiguousHostMessage(opts);
  if (ambiguous) {
    console.error(`[brighttest] --device: ${ambiguous}`);
    return 2;
  }
  const resolved = require('./device-command').resolveLaneOpts(opts);
  if (!resolved) {
    console.error('[brighttest] --device requires --host <ip> and --password <dev-password> (or ROKU_HOST / ROKU_PASSWORD)');
    return 2;
  }
  opts = resolved;
  const { bsconfigPath } = writeBsConfig(cfg, 'device', { lcov: !!opts.lcov });
  const rooibos = resolveBin('@ramonlobo/rooibos-roku', 'rooibos');
  const args = [rooibos, `--project=${bsconfigPath}`, `--host=${opts.host}`, `--password=${opts.password}`];
  const color = !!process.stdout.isTTY;
  const reporter = makeReporter(cfg, color);
  const splitter = lineSplitter(reporter.onLine);
  const timeoutMs = (opts.timeout || 900) * 1000; // default 15 min

  const got = await leaseFor(cfg, opts, deps);
  if (got.code != null) return got.code;
  const lease = got.lease;

  process.stdout.write(palette(color).dim('  building, deploying to the device, and running…') + '\n');
  try {
    return await new Promise((resolve) => {
      let out = '';
      let didTimeout = false;
      let settled = false;
      const child = startRooibos(args, lease, deps.spawn);
      const onData = (buf) => { const s = buf.toString(); out += s; splitter.push(s); };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const timer = setTimeout(() => { didTimeout = true; killTree(child); }, timeoutMs);
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        splitter.flush();
        resolve(finishDevice(cfg, opts, out, reporter.state, color, didTimeout));
      };
      child.on('close', done);
      child.on('error', done);
    });
  } finally {
    if (lease) lease.release();
  }
}

// Print the failure summary + totals, write LCOV (when requested), return an exit code. Per-test ✓/✗ were
// already streamed live by the reporter; this adds the end-of-run summary.
function finishDevice(cfg, opts, out, state, color, didTimeout) {
  const c = palette(color);
  const cases = state.cases;
  const { passed, failed } = state;
  const sawResult = /\[Rooibos Result\]/.test(out) || cases.length > 0;

  printFailures(cfg, out, cases, color);

  let lcovNote = '';
  let covNote = '';
  if (opts.lcov) {
    const { text, count } = extractLcov(out);
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
  if (!sawResult) {
    process.stderr.write('  ' + c.red('brighttest (device): no results — deploy or device error. Output tail:') + '\n');
    process.stderr.write(out.split(/\r\n|\r|\n/).slice(-25).join('\n') + '\n');
    process.stdout.write('─'.repeat(56) + '\n');
    return 1;
  }
  if (opts.lcov && !lcovNote) {
    process.stderr.write('  ' + c.red('brighttest (device): --lcov requested but no coverage was returned (is coverage on and did tests run?)') + '\n');
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
  const rooibos = resolveBin('@ramonlobo/rooibos-roku', 'rooibos');
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

module.exports = { run, extractLcov, buildAndRun };
