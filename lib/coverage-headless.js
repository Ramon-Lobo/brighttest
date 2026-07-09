'use strict';
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { writeBsConfig, findNodeSpecs } = require('./config');
const { resolveBin } = require('./tools');
const { extractLcov } = require('./device');

// Headless scene runner: run the STOCK Rooibos scene runner on the brs-node simulator (SceneGraph
// enabled). This is how @SGNode node suites run headless (with the patches in patches/ and lib/), and,
// with coverage on, how real LCOV is produced with NO device.
//   lane 'headless-coverage' → coverage + LCOV (the --coverage lane)
//   lane 'headless-scene'    → coverage off (the default lane uses this when @SGNode specs are present)
// Build the package and run it on brs-node, capturing the raw Rooibos output.
// Resolves { output, killReason, built }. brs-node doesn't self-exit, so we kill on the shutdown marker.
function buildAndRun(cfg, opts, lane = 'headless-coverage') {
  const { bsconfigPath, pkgPath } = writeBsConfig(cfg, lane, { excludeNodeSpecs: !!opts.noSgnode });

  const bsc = resolveBin('brighterscript', 'bsc');
  const build = spawnSync(process.execPath, [bsc, '--project', bsconfigPath], { encoding: 'utf8' });
  if (build.status !== 0 || !fs.existsSync(pkgPath)) {
    return Promise.resolve({ output: (build.stdout || '') + (build.stderr || ''), built: false });
  }

  const brsCli = resolveBin('@ramon-lobo/brs-node', 'brs-cli');
  // A full instrumented SceneGraph suite (hundreds of @SGNode suites + LCOV generation) can take
  // several minutes headless; default generously so a large run isn't cut off mid-finalization.
  const timeoutMs = (opts.timeout || 900) * 1000;
  // A large SceneGraph suite (hundreds of @SGNode suites + full LCOV) holds a lot of live data; the
  // single brs-node process can exhaust V8's default ~2–4 GB old-space heap right at finalization,
  // and node aborts (OOM) before its buffered stdout tail — including [Rooibos Result]/[Rooibos
  // Shutdown] — flushes, so the run looks like it "did not complete". Give the child a roomy heap.
  const heapMb = opts.maxHeapMb || 8192;
  return new Promise((resolve) => {
    // Redirect the child's stdout/stderr straight to a file instead of piping it through this
    // process. A full coverage run emits tens of thousands of lines very fast; a pipe throttles the
    // child on backpressure (and in-process accumulation/scanning adds more), which made capture take
    // 3–4× longer than the run itself. Writing to a file keeps the child at full speed; we poll the
    // file for the completion marker (reading only newly-appended bytes) to stop as soon as it's done.
    const logPath = path.join(path.dirname(pkgPath), 'run-output.log');
    const fd = fs.openSync(logPath, 'w');
    const child = spawn(process.execPath, [`--max-old-space-size=${heapMb}`, brsCli, pkgPath], { stdio: ['ignore', fd, fd] });
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
    // Poll for the completion marker by reading only the bytes appended since last check (with a
    // small overlap so a marker split across reads is still found). The child lingers after
    // [Rooibos Shutdown] (background render/task threads), so detect completion from the file and
    // then kill it, rather than waiting for the process to exit.
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
          if ((tail + s).includes('[Rooibos Shutdown]')) finish(null);
          tail = s.slice(-32);
        }
      } catch (e) { /* file not ready yet */ }
    }, 500);
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    child.on('error', () => finish('spawn-error'));
    child.on('close', () => finish(null));
  });
}

async function run(cfg, opts) {
  const coverage = opts.coverage === true;
  const lane = coverage ? 'headless-coverage' : 'headless-scene';
  const nodeSpecs = opts.noSgnode ? [] : findNodeSpecs(cfg);
  const { output, killReason, built } = await buildAndRun(cfg, opts, lane);
  if (!built) {
    process.stderr.write(output);
    console.error(`\n[roku-test] ${coverage ? 'coverage' : 'scene'} build failed`);
    return 1;
  }
  return report(output, cfg, opts, nodeSpecs, killReason, coverage);
}

// Parse Rooibos console output, write LCOV (+ optional JUnit), print a summary, return an exit code.
// `coverage` toggles LCOV output and the summary label (the default lane reuses this with coverage off).
function report(out, cfg, opts, nodeSpecs, killReason, coverage = true) {
  const label = coverage ? 'headless coverage' : 'headless (scenegraph)';
  const cases = [];
  for (const rawLine of out.split(/\r\n|\r|\n/)) {
    // brs-node colorizes a FAIL result red — `(\x1b[31mFAIL\x1b[39m)` — but leaves PASS plain, so a
    // regex over the raw line matches every PASS and SILENTLY DROPS every FAIL (the run then looks
    // green with "0 failed" even when tests failed). Strip ANSI escapes first. (cross-check.js does
    // the same for exactly this reason.)
    const line = rawLine.replace(/\x1b\[[0-9;]*m/g, '');
    const m = line.match(/<<<< END It:\s+(.+?)\s+\((PASS|FAIL)\)/);
    if (m) {
      const ok = m[2] === 'PASS';
      cases.push({ name: m[1].trim(), ok });
      console.log(`  ${ok ? '✓' : '✗'} ${m[1].trim()}`);
    }
  }
  const passM = out.match(/Passed:\s*(\d+)/);
  const failM = out.match(/Failed:\s*(\d+)/);
  const sawResult = /\[Rooibos Result\]/.test(out);
  // Prefer the actual per-test results parsed above; fall back to Rooibos's summary line only if no
  // individual cases were seen (the summary's "Passed:/Failed:" wording varies by reporter/version).
  const casesPassed = cases.filter((c) => c.ok).length;
  const casesFailed = cases.filter((c) => !c.ok).length;
  const passed = cases.length ? casesPassed : (passM ? +passM[1] : 0);
  const failed = cases.length ? casesFailed : (failM ? +failM[1] : 0);

  // LCOV from the printed coverage blocks (framework records filtered out). Coverage lane only.
  const { text, count } = coverage ? extractLcov(out) : { text: '', count: 0 };
  const covM = coverage ? out.match(/Total Coverage:\s*([\d.]+)%/) : null;
  const lcovPath = opts.lcov || 'coverage/lcov.info';
  if (text) {
    const dest = path.resolve(lcovPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
  }

  // Optional JUnit.
  if (opts.junit && cases.length) {
    const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="roku-test" tests="${cases.length}" failures="${failed}">\n` +
      cases.map((c) => c.ok ? `    <testcase name="${esc(c.name)}"/>\n` : `    <testcase name="${esc(c.name)}"><failure/></testcase>\n`).join('') +
      `  </testsuite>\n</testsuites>\n`;
    fs.mkdirSync(path.dirname(path.resolve(opts.junit)), { recursive: true });
    fs.writeFileSync(path.resolve(opts.junit), xml);
  }

  console.log('\n' + '='.repeat(56));
  if (killReason === 'timeout') {
    console.error(`  roku-test (${label}): TIMED OUT after ${opts.timeout || 900}s`);
    console.log('='.repeat(56));
    return 1;
  }
  if (!sawResult) {
    console.error(`  roku-test (${label}): no result — the run did not complete`);
    console.log('='.repeat(56));
    return 1;
  }
  const nodeNote = nodeSpecs.length ? `, ${nodeSpecs.length} @SGNode suite(s) run headless` : '';
  const covNote = covM ? `  |  coverage ${covM[1]}%` : '';
  console.log(`  roku-test (${label}): ${passed} passed, ${failed} failed${nodeNote}${covNote}`);
  if (text) console.log(`  LCOV: ${lcovPath}  (${count} file record(s))`);
  console.log('='.repeat(56));
  return failed > 0 ? 1 : 0;
}

module.exports = { run, buildAndRun };
