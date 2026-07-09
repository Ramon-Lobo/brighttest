'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { writeBsConfig, findNodeSpecs } = require('./config');
const { resolveBin } = require('./tools');

const DRIVER = path.join(__dirname, '..', 'brs', 'headless_runner.brs');

function listBrs(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listBrs(p));
    else if (e.name.endsWith('.brs')) out.push(p);
  }
  return out;
}

// Files that declare their own Main would collide with the driver's Main.
function declaresMain(file) {
  const src = fs.readFileSync(file, 'utf8');
  return /(^|\n)\s*(sub|function)\s+main\s*\(/i.test(src);
}

function xmlEscape(s) {
  return String(s).replace(/[<>&"']/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]
  ));
}

async function run(cfg, opts) {
  // @SGNode node suites need a real SceneGraph scene, which the fast SceneGraph-off driver below can't
  // host. When a project has @SGNode specs (and the user hasn't opted out with --no-sgnode), run the
  // whole suite through the stock Rooibos scene runner headless — no device, no coverage instrumentation.
  // Projects with no node specs (or --no-sgnode) keep the faster SceneGraph-off path below.
  if (!opts.noSgnode && findNodeSpecs(cfg).length > 0) {
    return require('./coverage-headless').run(cfg, { ...opts, coverage: false });
  }

  const { bsconfigPath, stagingBuild } = writeBsConfig(cfg, 'headless');

  // 1. Build (transpile + inject Rooibos runtime; coverage off).
  const bsc = resolveBin('brighterscript', 'bsc');
  const build = spawnSync(process.execPath, [bsc, '--project', bsconfigPath], { encoding: 'utf8' });
  if (build.status !== 0) {
    process.stdout.write(build.stdout || '');
    process.stderr.write(build.stderr || '');
    console.error('\n[roku-test] build failed');
    return 1;
  }

  // 2. Collect compiled source .brs (skip components/ — SG-only — and any Main declarer).
  const srcDir = path.join(stagingBuild, 'source');
  const files = listBrs(srcDir).filter((f) => !declaresMain(f));
  if (files.length === 0) {
    console.error('[roku-test] no compiled source found — is your test project set up? (source/, specs)');
    return 1;
  }

  // 3. Run headlessly on the brs-node simulator (its parser handles the Rooibos runtime).
  //    Watchdog: an infinite loop in a test would otherwise hang CI forever.
  const timeoutMs = (opts.timeout || 300) * 1000; // default 5 min (headless is fast)
  const brsCli = resolveBin('@ramonlobo/brs-node', 'brs-cli');
  const res = spawnSync(process.execPath, [brsCli, '-n', ...files, DRIVER], {
    encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL',
  });
  if ((res.error && res.error.code === 'ETIMEDOUT') || res.signal === 'SIGKILL') {
    console.error(`\n[roku-test] headless run timed out after ${opts.timeout || 300}s (possible infinite loop in a test).`);
    return 1;
  }
  const stdout = (res.stdout || '') + (res.stderr || '');

  // 4. Parse driver output.
  const cases = [];
  let passed = 0, failed = 0, skipped = 0, sawResult = false;
  for (const line of stdout.split(/\r\n|\r|\n/)) {
    let m = line.match(/^\s*PASS\s+(.+)$/);
    if (m) { cases.push({ name: m[1].trim(), ok: true }); console.log('  ✓ ' + m[1].trim()); continue; }
    m = line.match(/^\s*FAIL\s+(.+?)\s+--\s+(.*)$/);
    if (m) { cases.push({ name: m[1].trim(), ok: false, msg: m[2] }); console.log('  ✗ ' + m[1].trim() + '  — ' + m[2]); continue; }
    m = line.match(/^\s*SKIP\s+(.+)$/);
    if (m) { console.log('  ○ ' + m[1].trim()); continue; }
    m = line.match(/^__RESULT__ .*passed=(\d+) failed=(\d+)(?: skipped=(\d+))?/);
    if (m) { sawResult = true; passed = +m[1]; failed = +m[2]; skipped = m[3] ? +m[3] : 0; }
  }

  if (!sawResult) {
    console.error('\n[roku-test] headless run produced no result. Interpreter output tail:');
    console.error(stdout.split('\n').slice(-20).join('\n'));
    return 1;
  }

  // 5. JUnit report.
  if (opts.junit) {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="roku-test" tests="${cases.length}" failures="${failed}">\n` +
      cases.map((c) => c.ok
        ? `    <testcase name="${xmlEscape(c.name)}"/>\n`
        : `    <testcase name="${xmlEscape(c.name)}">\n      <failure>${xmlEscape(c.msg || '')}</failure>\n    </testcase>\n`
      ).join('') +
      `  </testsuite>\n</testsuites>\n`;
    fs.mkdirSync(path.dirname(path.resolve(opts.junit)), { recursive: true });
    fs.writeFileSync(path.resolve(opts.junit), xml);
    console.log(`\nJUnit report: ${opts.junit}`);
  }

  const skipNote = skipped > 0 ? `, ${skipped} @SGNode skipped (--no-sgnode)` : '';
  console.log('\n' + '='.repeat(52));
  console.log(`  roku-test (headless): ${passed} passed, ${failed} failed${skipNote}`);
  console.log('='.repeat(52));
  return failed > 0 ? 1 : 0;
}

module.exports = { run };
