'use strict';
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { writeBsConfig, findNodeSpecs } = require('./config');
const { resolveBin } = require('./tools');
const { extractLcov } = require('./device');
const { palette, makeReporter, lineSplitter, printFailures } = require('./reporter');

// Headless scene runner: run the STOCK Rooibos scene runner on the brs-node simulator (SceneGraph
// enabled). This is how @SGNode node suites run headless, and — with coverage on — how real LCOV is
// produced with NO device.
//   lane 'headless-coverage' → coverage + LCOV (the --coverage lane)
//   lane 'headless-scene'    → coverage off (the default lane uses this when @SGNode specs are present)
// Streams lines to `onLine` as they arrive and captures the full output. brs-node doesn't self-exit, so
// we kill on the shutdown marker.
function buildAndRun(cfg, opts, lane = 'headless-coverage', onLine) {
  const { bsconfigPath, pkgPath } = writeBsConfig(cfg, lane, { excludeNodeSpecs: !!opts.noSgnode });

  if (onLine) process.stdout.write(palette(!!process.stdout.isTTY).dim('  building the test bundle…') + '\n');
  const bsc = resolveBin('brighterscript', 'bsc');
  const build = spawnSync(process.execPath, [bsc, '--project', bsconfigPath], { encoding: 'utf8' });
  if (build.status !== 0 || !fs.existsSync(pkgPath)) {
    return Promise.resolve({ output: (build.stdout || '') + (build.stderr || ''), built: false });
  }

  const brsCli = resolveBin('@ramonlobo/brs-node', 'brs-cli');
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
    const child = spawn(process.execPath, [`--max-old-space-size=${heapMb}`, brsCli, pkgPath], { stdio: ['ignore', fd, fd] });
    const splitter = onLine ? lineSplitter(onLine) : null;
    let done = false;
    let readPos = 0;
    let tail = '';
    const finish = (killReason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
      try { fs.closeSync(fd); } catch (e) { /* already closed */ }
      let output = '';
      try { output = fs.readFileSync(logPath, 'utf8'); } catch (e) { /* nothing written */ }
      resolve({ output, killReason, built: true });
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
    child.on('close', () => finish(null));
  });
}

async function run(cfg, opts) {
  const coverage = opts.coverage === true;
  const lane = coverage ? 'headless-coverage' : 'headless-scene';
  const nodeSpecs = opts.noSgnode ? [] : findNodeSpecs(cfg);
  const color = !!process.stdout.isTTY;
  const reporter = makeReporter(cfg, color);
  const { output, killReason, built } = await buildAndRun(cfg, opts, lane, reporter.onLine);
  if (!built) {
    process.stderr.write(output);
    console.error(`\n[brighttest] ${coverage ? 'coverage' : 'scene'} build failed`);
    return 1;
  }
  return report(output, cfg, opts, nodeSpecs, killReason, coverage, reporter.state, color);
}

// Print the failure summary + totals, write LCOV (+ optional JUnit), return an exit code. Per-test ✓/✗
// were already streamed live by the reporter; this only adds the summary at the end.
function report(out, cfg, opts, nodeSpecs, killReason, coverage, state, color) {
  const c = palette(color);
  const label = coverage ? 'headless coverage' : 'headless';
  const cases = state.cases;
  const { passed, failed } = state;
  const sawResult = /\[Rooibos Result\]/.test(out) || cases.length > 0;

  // LCOV (coverage lane only).
  const { text, count } = coverage ? extractLcov(out) : { text: '', count: 0 };
  const covM = coverage ? out.match(/Total Coverage:\s*([\d.]+)%/) : null;
  const lcovPath = opts.lcov || 'coverage/lcov.info';
  if (text) {
    const dest = path.resolve(lcovPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
  }

  printFailures(cfg, out, cases, color);

  // Optional JUnit (with failure messages + suite as classname).
  if (opts.junit && cases.length) {
    const { failureMessages } = require('./reporter');
    const esc = (s) => String(s).replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]));
    const msgs = failureMessages(out);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="brighttest" tests="${cases.length}" failures="${failed}">\n` +
      cases.map((t) => {
        const attrs = `name="${esc(t.name)}"${t.suite ? ` classname="${esc(t.suite)}"` : ''}`;
        return t.ok ? `    <testcase ${attrs}/>\n` : `    <testcase ${attrs}><failure>${esc(msgs[t.name] || 'failed')}</failure></testcase>\n`;
      }).join('') +
      `  </testsuite>\n</testsuites>\n`;
    fs.mkdirSync(path.dirname(path.resolve(opts.junit)), { recursive: true });
    fs.writeFileSync(path.resolve(opts.junit), xml);
  }

  process.stdout.write('\n' + '─'.repeat(56) + '\n');
  if (killReason === 'timeout') {
    process.stderr.write('  ' + c.red(`brighttest (${label}): TIMED OUT after ${opts.timeout || 900}s`) + '\n');
    process.stdout.write('─'.repeat(56) + '\n');
    return 1;
  }
  if (!sawResult) {
    process.stderr.write('  ' + c.red(`brighttest (${label}): no result — the run did not complete`) + '\n');
    process.stdout.write('─'.repeat(56) + '\n');
    return 1;
  }
  const suitesRun = new Set(cases.map((t) => t.suite).filter(Boolean)).size;
  const suitesNote = suitesRun ? c.dim(` · ${suitesRun} suites`) : '';
  const covNote = covM ? c.dim(` · coverage ${covM[1]}%`) : '';
  const tally = `${c.green(passed + ' passed')}, ${failed ? c.red(failed + ' failed') : failed + ' failed'}`;
  process.stdout.write(`  brighttest (${label}): ${tally}${suitesNote}${covNote}\n`);
  if (text) process.stdout.write('  ' + c.dim(`LCOV: ${lcovPath}  (${count} file record(s))`) + '\n');
  process.stdout.write('─'.repeat(56) + '\n');
  return failed > 0 ? 1 : 0;
}

module.exports = { run, buildAndRun };
