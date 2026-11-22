'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { writeBsConfig, findNodeSpecs, toEngineDeviceInfo } = require('./config');
const { resolveBin } = require('./tools');
const { engineBin, enginePackageMain, printBanner } = require('./engines');

const ENGINE_RUN = path.join(__dirname, 'engine-run.js');
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

// Async stand-in for spawnSync(..., { encoding, timeout, killSignal: 'SIGKILL' }): the event loop stays free
// (an in-process instrument hub must be able to answer the child). Resolves { stdout, stderr, status,
// signal, error } with the same shape and the same timeout reporting (error.code 'ETIMEDOUT', signal SIGKILL).
function spawnCapture(cmd, args, { timeout } = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false, settled = false, timer = null;
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const done = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, ...r });
    };
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    child.on('error', (error) => done({ status: null, signal: null, error }));
    child.on('close', (status, signal) => {
      if (timedOut) return done({ status: null, signal: 'SIGKILL', error: Object.assign(new Error('spawn ETIMEDOUT'), { code: 'ETIMEDOUT' }) });
      done({ status, signal });
    });
    if (timeout) {
      timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch (e) { /* gone */ } }, timeout);
    }
  });
}

async function runSuite(cfg, opts, netCtx) {
  // @SGNode node suites need a real SceneGraph scene, which the fast SceneGraph-off driver below can't
  // host. When a project has @SGNode specs (and the user hasn't opted out with --no-sgnode), run the
  // whole suite through the stock Rooibos scene runner headless — no device, no coverage instrumentation.
  // Projects with no node specs (or --no-sgnode) keep the faster SceneGraph-off path below.
  if (!opts.noSgnode && findNodeSpecs(cfg).length > 0) {
    return require('./coverage-headless').run(cfg, { ...opts, coverage: false, _net: netCtx || undefined });
  }

  printBanner(cfg);
  const { bsconfigPath, stagingBuild } = writeBsConfig(cfg, 'headless', netCtx ? { net: netCtx } : {});

  // 1. Build (transpile + inject Rooibos runtime; coverage off).
  const bsc = resolveBin('brighterscript', 'bsc');
  const build = spawnSync(process.execPath, [bsc, '--project', bsconfigPath], { encoding: 'utf8' });
  if (build.status !== 0) {
    process.stdout.write(build.stdout || '');
    process.stderr.write(build.stderr || '');
    console.error('\n[brighttest] build failed');
    return 1;
  }

  // 2. Collect compiled source .brs (skip components/ — SG-only — and any Main declarer).
  const srcDir = path.join(stagingBuild, 'source');
  const files = listBrs(srcDir).filter((f) => !declaresMain(f));
  if (files.length === 0) {
    console.error('[brighttest] no compiled source found — is your test project set up? (source/, specs)');
    return 1;
  }

  // 3. Run headlessly on the brs-node simulator (its parser handles the Rooibos runtime).
  //    Watchdog: an infinite loop in a test would otherwise hang CI forever.
  const timeoutMs = (opts.timeout || 300) * 1000; // default 5 min (headless is fast)
  engineBin('brsNode', cfg); // resolves (and errors on) the engine
  const brsMain = enginePackageMain('brsNode', cfg);
  // With net, the engine reads the staged manifest (`bs_const=BT_AGENT=true`, which the generated BT_config.brs
  // needs) via --root; root-relative file paths are then required, so the driver is copied into the staging root.
  // The engine's CLI has no device-identity flag, so the run goes through lib/engine-run.js (the engine API) with
  // the project's `deviceInfo` block (COV-02).
  const deviceJson = JSON.stringify(toEngineDeviceInfo(cfg.deviceInfo || {}));
  let runArgs = [...files, DRIVER];
  if (netCtx) {
    const driverCopy = path.join(stagingBuild, '__bt_driver.brs');
    fs.copyFileSync(DRIVER, driverCopy);
    runArgs = ['-r', stagingBuild, ...[...files, driverCopy].map((f) => path.relative(stagingBuild, f))];
  }
  const res = await spawnCapture(process.execPath, [ENGINE_RUN, brsMain, deviceJson, ...runArgs], { timeout: timeoutMs });
  if ((res.error && res.error.code === 'ETIMEDOUT') || res.signal === 'SIGKILL') {
    console.error(`\n[brighttest] headless run timed out after ${opts.timeout || 300}s (possible infinite loop in a test).`);
    return 1;
  }
  const stdout = (res.stdout || '') + (res.stderr || '');

  // 4. Parse driver output.
  const cases = [];
  let passed = 0, failed = 0, skipped = 0, sawResult = false;
  for (const raw of stdout.split(/\r\n|\r|\n/)) {
    // brs-node colorizes printed values (incl. the numbers in the __RESULT__ line); strip ANSI so the
    // strict `passed=(\d+)` / PASS|FAIL regexes below match.
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
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
    console.error('\n[brighttest] headless run produced no result. Interpreter output tail:');
    console.error(stdout.split('\n').slice(-20).join('\n'));
    return 1;
  }

  // 5. JUnit report.
  if (opts.junit) {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="brighttest" tests="${cases.length}" failures="${failed}">\n` +
      cases.map((c) => c.ok
        ? `    <testcase name="${xmlEscape(c.name)}"/>\n`
        : `    <testcase name="${xmlEscape(c.name)}">\n      <failure>${xmlEscape(c.msg || '')}</failure>\n    </testcase>\n`
      ).join('') +
      `  </testsuite>\n</testsuites>\n`;
    fs.mkdirSync(path.dirname(path.resolve(opts.junit)), { recursive: true });
    fs.writeFileSync(path.resolve(opts.junit), xml);
    console.log(`\nJUnit report: ${opts.junit}`);
  }

  // Failure summary — list each failed test with its reason so it's not buried in the pass list.
  const on = !!process.stdout.isTTY;
  const col = (a, b) => (s) => (on ? `\x1b[${a}m${s}\x1b[${b}m` : String(s));
  const red = col(31, 39), bold = col(1, 22), yellow = col(33, 39), dim = col(2, 22);
  const fails = cases.filter((t) => !t.ok);
  if (fails.length) {
    console.log('\n' + red(bold(`  Failures (${fails.length})`)));
    for (const f of fails) {
      console.log('\n  ' + red('✗ ') + bold(f.name));
      if (f.msg) console.log('    ' + yellow(f.msg));
    }
  }

  const skipNote = skipped > 0 ? dim(` · ${skipped} @SGNode skipped (--no-sgnode)`) : '';
  console.log('\n' + '─'.repeat(52));
  console.log(`  brighttest (headless): ${passed} passed, ${failed} failed${skipNote}`);
  console.log('─'.repeat(52));
  return failed > 0 ? 1 : 0;
}

// The instrument hub (ADR 0016) runs in-process for the whole headless run under localLease() (always held).
// It starts before the run's first request and stops afterwards on success, failure and thrown error. A hub
// that cannot start (e.g. no loopback listener) warns and never changes the run's inputs or result.
// `net` (optional, NET-N-T5): { token, proxy } from instrument/net-headless.js; the hub then mounts the proxy.
async function withHub(fn, { startHub, localLease } = require('./instrument/hub'), net = null) {
  let hub = null;
  try {
    hub = await startHub({
      host: '127.0.0.1', port: 0, mode: 'headless', lease: localLease(),
      tokens: [net ? net.token : require('crypto').randomBytes(16).toString('hex')],
      ...(net ? { netProxy: net.proxy } : {}),
    });
  } catch (e) {
    console.error(`[brighttest] instrument hub not started: ${e.message}`);
  }
  try {
    return await fn(hub);
  } finally {
    if (hub) await hub.stop();
  }
}

// Runs `inner(netCtx)` under the hub. When the run uses `net` (flags, config fixtures or BTNet_ specs) the hub also
// serves the net proxy and netCtx = { token, host, port } feeds the build; the run NDJSON / HAR are written after.
async function runWithNet(cfg, opts, deps, inner) {
  const netHeadless = require('./instrument/net-headless');
  let net = null;
  try { net = netHeadless.prepare(cfg, opts); } catch (e) {
    if (e && e.name === 'NetRuleError') { console.error(`[brighttest] net: ${e.message}`); return 2; }
    throw e;
  }
  try {
    return await withHub(async (hub) => {
      if (net && !hub) { console.error('[brighttest] net: the instrument hub could not start; network fixtures need it'); return 1; }
      return inner(net ? net.ctx(hub) : undefined);
    }, deps, net);
  } finally {
    if (net) net.finish();
  }
}

function run(cfg, opts, deps) {
  return runWithNet(cfg, opts, deps, (netCtx) => runSuite(cfg, opts, netCtx));
}

module.exports = { run, runSuite, withHub, runWithNet, spawnCapture };
