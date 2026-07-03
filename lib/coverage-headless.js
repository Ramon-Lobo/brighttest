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

  const brsCli = resolveBin('brs-node', 'brs-cli');
  const timeoutMs = (opts.timeout || 300) * 1000;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [brsCli, pkgPath], { encoding: 'utf8' });
    let out = '';
    let done = false;
    const finish = (killReason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
      resolve({ output: out, killReason, built: true });
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    const onData = (buf) => {
      out += buf.toString();
      if (/\[Rooibos Shutdown\]/.test(out)) finish(null); // whole run (incl coverage) complete
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { out += '\n' + e.message; finish('spawn-error'); });
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
  for (const line of out.split(/\r\n|\r|\n/)) {
    const m = line.match(/<<<< END It:\s+(.+?)\s+\((PASS|FAIL)\)/);
    if (m) {
      const ok = m[2] === 'PASS';
      cases.push({ name: m[1].trim(), ok });
      console.log(`  ${ok ? '✓' : '✗'} ${m[1].trim()}`);
    }
  }
  const totalM = out.match(/Total:\s*(\d+)/);
  const passM = out.match(/Passed:\s*(\d+)/);
  const failM = out.match(/Failed:\s*(\d+)/);
  const sawResult = /\[Rooibos Result\]/.test(out);
  const passed = passM ? +passM[1] : 0;
  const failed = failM ? +failM[1] : 0;

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
    console.error(`  roku-test (${label}): TIMED OUT after ${opts.timeout || 300}s`);
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
