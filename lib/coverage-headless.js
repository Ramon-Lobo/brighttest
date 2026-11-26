'use strict';
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { writeBsConfig, findNodeSpecs, toEngineDeviceInfo } = require('./config');
const { resolveBin } = require('./tools');
const { engineBin, engineFor, supportsFlag, printBanner } = require('./engines');
const { extractLcov } = require('./device');
const { palette, makeReporter, lineSplitter, printFailures, parseSummary, laneFailures, treeCases } = require('./reporter');

// Headless scene runner: run the STOCK Rooibos scene runner on the brs-node simulator (SceneGraph
// enabled). This is how @SGNode node suites run headless, and — with coverage on — how real LCOV is
// produced with NO device.
//   lane 'headless-coverage' → coverage + LCOV (the --coverage lane)
//   lane 'headless-scene'    → coverage off (the default lane uses this when @SGNode specs are present)
// Streams lines to `onLine` as they arrive and captures the full output. brs-node doesn't self-exit, so
// we kill on the shutdown marker.
// Stream the bytes of `raw` past `readPos` (a byte offset) to the splitter, then flush its partial last line.
function flushUnread(raw, readPos, splitter) {
  if (!splitter) return;
  if (raw.length > readPos) splitter.push(raw.subarray(readPos).toString('utf8'));
  splitter.flush();
}

// The scene lane runs through the engine CLI, which only takes the device identity when it has `--device-data`.
// Returns the extra argv for the engine, or [] (with a one-time warning) when the engine lacks the flag.
let warnedDeviceData = false;
function deviceDataArgs(cfg, deps = {}) {
  if (!cfg.deviceInfo) return [];
  let supported = false;
  try { supported = supportsFlag((deps.engineFor || engineFor)('brsNode', cfg), 'device-data'); } catch { /* unresolved: no flag */ }
  if (supported) return ['--device-data', JSON.stringify(toEngineDeviceInfo(cfg.deviceInfo))];
  if (!warnedDeviceData) {
    warnedDeviceData = true;
    process.stderr.write('[brighttest] deviceInfo is set but this engine has no --device-data flag; the scene lane keeps the engine device identity (use a patched @ramonlobo/brs-node)\n');
  }
  return [];
}

function buildAndRun(cfg, opts, lane = 'headless-coverage', onLine) {
  printBanner(cfg);
  const { bsconfigPath, pkgPath } = writeBsConfig(cfg, lane, { excludeNodeSpecs: !!opts.noSgnode, ...(opts._instrument ? { instrument: opts._instrument } : opts._net ? { net: opts._net } : {}) });

  if (onLine) process.stdout.write(palette(!!process.stdout.isTTY).dim('  building the test bundle…') + '\n');
  const bsc = resolveBin('brighterscript', 'bsc');
  const build = spawnSync(process.execPath, [bsc, '--project', bsconfigPath], { encoding: 'utf8' });
  if (build.status !== 0 || !fs.existsSync(pkgPath)) {
    return Promise.resolve({ output: (build.stdout || '') + (build.stderr || ''), built: false });
  }

  const brsCli = engineBin('brsNode', cfg);
  const timeoutMs = (opts.timeout || 900) * 1000;
  // A large SceneGraph suite holds a lot of live data; the single brs-node process can exhaust V8's
  // default heap right at finalization. Give the child a roomy heap so the run completes.
  const heapMb = opts.maxHeapMb || 8192;
  return new Promise((resolve) => {
    // Redirect the child's stdout/stderr to a file (a pipe throttles the fast, high-volume child on
    // backpressure). Poll the file for newly-appended bytes both to stream progress and to detect the
    // completion marker.
    const logPath = path.join(path.dirname(pkgPath), 'run-output.log');
    const fd = fs.openSync(logPath, 'w');
    const child = spawn(process.execPath, [`--max-old-space-size=${heapMb}`, brsCli, ...deviceDataArgs(cfg), pkgPath], { stdio: ['ignore', fd, fd] });
    const splitter = onLine ? lineSplitter(onLine) : null;
    let done = false;
    let readPos = 0;
    let tail = '';
    const finish = (killReason, exit) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
      try { fs.closeSync(fd); } catch (e) { /* already closed */ }
      let raw = Buffer.alloc(0);
      try { raw = fs.readFileSync(logPath); } catch (e) { /* nothing written */ }
      const output = raw.toString('utf8');
      // An engine that dies right away (a crash) can exit before the next poll: stream what was never read.
      flushUnread(raw, readPos, splitter);
      resolve({ output, killReason, built: true, exit: exit || null });
    };
    const poll = setInterval(() => {
      try {
        const size = fs.statSync(logPath).size;
        if (size > readPos) {
          const rfd = fs.openSync(logPath, 'r');
          const buf = Buffer.alloc(size - readPos);
          fs.readSync(rfd, buf, 0, buf.length, readPos);
          fs.closeSync(rfd);
          readPos = size;
          const s = buf.toString();
          if (splitter) splitter.push(s);
          if ((tail + s).includes('[Rooibos Shutdown]')) finish(null);
          tail = s.slice(-32);
        }
      } catch (e) { /* file not ready yet */ }
    }, 200);
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    child.on('error', () => finish('spawn-error'));
    // The exit status only matters when the child ended on its own: a run we stopped at the Shutdown marker was killed by us.
    child.on('close', (code, signal) => finish(null, { code, signal }));
  });
}

async function run(cfg, opts) {
  // Net fixtures / --net-* flags / BTNet_ specs: run under the hub + proxy (headless.js), then come back with the context.
  if (!opts._net && !opts._instrument && require('./headless').instrumentWanted(cfg, opts)) {
    return require('./headless').runWithNet(cfg, opts, undefined, (ctx) => run(cfg, { ...opts, _instrument: ctx }));
  }
  const coverage = opts.coverage === true;
  const lane = coverage ? 'headless-coverage' : 'headless-scene';
  const nodeSpecs = opts.noSgnode ? [] : findNodeSpecs(cfg);
  const color = !!process.stdout.isTTY;
  const reporter = makeReporter(cfg, color);
  const { output, killReason, built, exit } = await buildAndRun(cfg, opts, lane, reporter.onLine);
  if (!built) {
    process.stderr.write(output);
    console.error(`\n[brighttest] ${coverage ? 'coverage' : 'scene'} build failed`);
    return 1;
  }
  return report(output, cfg, opts, nodeSpecs, killReason, coverage, reporter.state, color, exit);
}

// Drops the LCOV records of the injected instrument runtime (source/bt/**, components/bt/**).
function dropToolRecords(text) {
  const records = text.split(/(?<=end_of_record\n)/).filter((r) => r.trim());
  const kept = records.filter((r) => {
    const m = /^SF:(.*)$/m.exec(r);
    return !(m && /(^|\/)(source|components)\/bt\//.test(m[1].replace(/\\/g, '/')));
  });
  return { text: kept.join(''), count: kept.length };
}

// Print the failure summary + totals, write LCOV (+ optional JUnit), return an exit code. Per-test ✓/✗
// were already streamed live by the reporter; this only adds the summary at the end.
function report(out, cfg, opts, nodeSpecs, killReason, coverage, state, color, exit) {
  const c = palette(color);
  const label = coverage ? 'headless coverage' : 'headless';
  const cases = state.cases;
  // Prefer Rooibos's authoritative summary for the tally/exit code — the streamed per-test markers
  // undercount long-named tests (see parseSummary). Fall back to the streamed counts if it's absent.
  const summary = parseSummary(out);
  const passed = summary ? Math.max(summary.passed, state.passed) : state.passed;
  const lane = laneFailures(out, state.failed);
  // A child that exits non-zero, or on a signal, before the Shutdown marker died mid-run: that is a crash, not a pass.
  const abnormalExit = exit && !/\[Rooibos Shutdown\]/.test(out) && (exit.signal || (exit.code != null && exit.code !== 0));
  const exitReason = abnormalExit ? (exit.signal ? `process killed by ${exit.signal}` : `process exited with code ${exit.code}`) : '';
  const exitCrash = abnormalExit ? { reason: exitReason, cases: [{ name: 'run crashed', reason: `${exitReason} before the Shutdown marker; the results are incomplete` }] } : null;
  // Declared-vs-run: the summary declares `Total: N`; fewer results than that means tests never ran.
  const accounted = summary ? summary.passed + summary.failed + summary.crashed + summary.ignored : 0;
  const ran = Math.max(cases.length, accounted, treeCases(out).length);
  const shortfall = summary && ran < summary.total ? { reason: `${ran} of ${summary.total} declared tests ran`, cases: [{ name: 'run crashed', reason: `only ${ran} of ${summary.total} declared tests ran; the results are incomplete` }] } : null;
  const crash = lane.crash || exitCrash || shortfall;
  if (crash && !lane.crash && lane.failed === 0) lane.failed = 1;
  const failed = lane.failed; // max(streamed, summary, report tree), plus a crashed engine or an incomplete run
  const sawResult = !!summary || /\[Rooibos Result\]/.test(out) || cases.length > 0;

  // LCOV (coverage lane only).
  let { text, count } = coverage ? extractLcov(out) : { text: '', count: 0 };
  // The instrument plugin bakes its own runtime into source/bt and components/bt: that is tool code, not the app's.
  if (text && opts._instrument) ({ text, count } = dropToolRecords(text));
  const lcovPath = opts.lcov || 'coverage/lcov.info';
  const noLcov = coverage && !text;
  if (text) {
    const dest = path.resolve(lcovPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
  }

  printFailures(cfg, out, cases, color);

  // Jest-style coverage table (overall + per-file line coverage). Also gives us the overall % for the
  // totals line, since brs-node doesn't print a "Total Coverage" summary of its own.
  let overallPct = null;
  if (text) {
    const { printCoverageTable } = require('./coverage-report');
    overallPct = printCoverageTable(text, cfg, color);
  }

  // Optional JUnit (with failure messages + suite as classname). Cases that never streamed an END marker (dropped
  // after an @async stall, or only seen as FAIL/CRASH in the report tree) get their own failing <testcase> so
  // `tests`, `failures` and the elements agree with the exit code.
  if (opts.junit) {
    require('./reporter').buildRooibosJunit({ junit: opts.junit, cases, out, failed, crash, killReason, sawResult, timeout: opts.timeout, lane: 'headless', cfg });
  }

  process.stdout.write('\n' + '─'.repeat(56) + '\n');
  if (killReason === 'timeout') {
    process.stderr.write('  ' + c.red(`brighttest (${label}): TIMED OUT after ${opts.timeout || 900}s`) + '\n');
    process.stdout.write('─'.repeat(56) + '\n');
    return 1;
  }
  if (crash) {
    process.stderr.write('  ' + c.red(`brighttest (${label}): RUN CRASHED (${crash.reason}): results are incomplete`) + '\n');
  } else if (!sawResult) {
    process.stderr.write('  ' + c.red(`brighttest (${label}): no result — the run did not complete`) + '\n');
    process.stdout.write('─'.repeat(56) + '\n');
    return 1;
  }
  const suitesRun = new Set(cases.map((t) => t.suite).filter(Boolean)).size;
  const suitesNote = suitesRun ? c.dim(` · ${suitesRun} suites`) : '';
  const covNote = overallPct != null ? c.dim(` · lines ${overallPct.toFixed(2)}%`) : '';
  const tally = `${c.green(passed + ' passed')}, ${failed ? c.red(failed + ' failed') : failed + ' failed'}`;
  process.stdout.write(`  brighttest (${label}): ${tally}${suitesNote}${covNote}\n`);
  if (text) process.stdout.write('  ' + c.dim(`LCOV: ${lcovPath}  (${count} file record(s))`) + '\n');
  if (noLcov) process.stderr.write('  ' + c.red(`brighttest (${label}): coverage requested but no LCOV in output`) + '\n');
  process.stdout.write('─'.repeat(56) + '\n');
  return failed > 0 || noLcov ? 1 : 0;
}

module.exports = { run, buildAndRun, deviceDataArgs, report, flushUnread, dropToolRecords };
