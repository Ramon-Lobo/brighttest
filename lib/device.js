'use strict';
const { spawnSync, spawn } = require('child_process');
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

function timedOut(res) {
  // spawnSync sets .error ETIMEDOUT (and kills with the given signal) when `timeout` is exceeded.
  return (res.error && res.error.code === 'ETIMEDOUT') || res.signal === 'SIGKILL';
}

// Device lane: build with coverage ON, deploy via the stock Rooibos CLI, and run on hardware — streaming
// the same grouped, Jest-style view + failure summary as the headless lanes (Rooibos emits identical
// console markers on device). The Rooibos device CLI self-exits when the run finishes, so we resolve on
// close, guarded by a watchdog timeout.
async function run(cfg, opts) {
  if (!opts.host || !opts.password) {
    console.error('[brighttest] --device requires --host <ip> and --password <dev-password>');
    return 2;
  }
  const { bsconfigPath } = writeBsConfig(cfg, 'device', { lcov: !!opts.lcov });
  const rooibos = resolveBin('@ramonlobo/rooibos-roku', 'rooibos');
  const args = [rooibos, `--project=${bsconfigPath}`, `--host=${opts.host}`, `--password=${opts.password}`];
  const color = !!process.stdout.isTTY;
  const reporter = makeReporter(cfg, color);
  const splitter = lineSplitter(reporter.onLine);
  const timeoutMs = (opts.timeout || 900) * 1000; // default 15 min

  process.stdout.write(palette(color).dim('  building, deploying to the device, and running…') + '\n');
  return new Promise((resolve) => {
    let out = '';
    let didTimeout = false;
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const onData = (buf) => { const s = buf.toString(); out += s; splitter.push(s); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => { didTimeout = true; try { child.kill('SIGKILL'); } catch (e) { /* gone */ } }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      splitter.flush();
      resolve(finishDevice(cfg, opts, out, reporter.state, color, didTimeout));
    };
    child.on('close', done);
    child.on('error', done);
  });
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
// own diff/summary — no streaming here).
function buildAndRun(cfg, opts) {
  const { bsconfigPath } = writeBsConfig(cfg, 'device', { lcov: false });
  const rooibos = resolveBin('@ramonlobo/rooibos-roku', 'rooibos');
  const args = [rooibos, `--project=${bsconfigPath}`, `--host=${opts.host}`, `--password=${opts.password}`];
  const res = spawnSync(process.execPath, args, {
    encoding: 'utf8', timeout: (opts.timeout || 900) * 1000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
  });
  return { output: (res.stdout || '') + (res.stderr || ''), status: res.status, timedOut: timedOut(res) };
}

module.exports = { run, extractLcov, buildAndRun };
