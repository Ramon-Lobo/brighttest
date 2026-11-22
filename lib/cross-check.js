'use strict';
const coverageHeadless = require('./coverage-headless');
const device = require('./device');
const { laneFailures } = require('./reporter');
const { findNodeSpecs, findNetSpecs } = require('./config');

// Parse stock-Rooibos console output into a map of "suite | group | test" -> pass(boolean).
// Both the headless --coverage lane and the device lane use the same Rooibos reporter, so the keys
// line up and can be diffed directly.
function parseRooibosCases(output) {
  const cases = new Map();
  let suite = '', group = '';
  for (const rawLine of output.split(/\r\n|\r|\n/)) {
    // Strip ANSI color escapes: the headless (brs-engine) lane colorizes interpolated values
    // (true/false/numbers) in test names, but the real-device telnet output is plain — so the same
    // test would key differently per lane and show as unmatched. Normalize both to plain text.
    const raw = rawLine.replace(/\x1b\[[0-9;]*m/g, '');
    const line = raw.replace(/[>=<]+\s*$/, '').trimEnd();
    let m = line.match(/^\s*>\s*SUITE:\s*(.+)$/);
    if (m) { suite = m[1].trim(); group = ''; continue; }
    m = line.match(/Describe:\s*(.+)$/);
    if (m) { group = m[1].trim(); continue; }
    m = raw.match(/<<<<\s*END It:\s+(.+?)\s+\((PASS|FAIL)\)/);
    if (m) cases.set(`${suite} | ${group} | ${m[1].trim()}`, m[2] === 'PASS');
  }
  return cases;
}

// Cross-check lane: run every suite BOTH headless (--coverage runner) and on the device, then diff the
// overlap to surface simulator-vs-device fidelity divergence. With the rooibos-roku promises patch,
// @SGNode node suites now run in BOTH lanes, so they're cross-checked too; anything that still runs only
// on the device (e.g. a suite that doesn't complete headless) is reported as device-only.
async function run(cfg, opts, deps = {}) {
  const dc = require('./device-command');
  // `--device any` (no explicit host): checked now (fail fast), picked at the device phase's own lease below.
  const pf = dc.poolForLane(cfg, opts);
  if (pf.code != null) return pf.code;
  const pool = pf.pool;
  if (pool) {
    const bad = dc.poolPreflight(pool, opts);
    if (bad) { console.error(`[brighttest] ${bad}`); return 2; }
  } else {
    const ambiguous = dc.ambiguousHostMessage(opts);
    if (ambiguous) {
      console.error(`[brighttest] --cross-check: ${ambiguous}`);
      return 2;
    }
    const resolved = dc.resolveLaneOpts(opts);
    if (!resolved) {
      console.error('[brighttest] --cross-check requires --host <ip> and --password <dev-password> (or ROKU_HOST / ROKU_PASSWORD)');
      return 2;
    }
    opts = resolved;
  }

  console.log('› headless run (brs-node simulator)…');
  // Net fixtures / BTNet_ specs: the headless leg runs under the hub + proxy; the device leg drops BTNet_ specs.
  const headlessRun = deps.headless || coverageHeadless.buildAndRun;
  let hl;
  if (!deps.headless && require('./instrument/net-headless').isActive(cfg, opts)) {
    let leg = null;
    const code = await require('./headless').runWithNet(cfg, opts, undefined, async (netCtx) => { leg = await headlessRun(cfg, { ...opts, _net: netCtx }); return 0; });
    if (!leg) return code || 1;
    hl = leg;
  } else hl = await headlessRun(cfg, opts);
  if (!hl.built) { process.stderr.write(hl.output); console.error('[brighttest] headless build failed'); return 1; }
  const headlessCases = parseRooibosCases(hl.output);

  // The lease covers only the device phase: taken just before it, released before the diff report.
  const acquireForLane = deps.acquireForLane || require('./device-command').acquireForLane;
  const got = await acquireForLane(pool ? { cfg, opts, pool } : { cfg, opts, host: opts.host, password: opts.password });
  if (got.code != null) return got.code;
  if (pool) {
    const r = dc.resolveLaneOpts({ ...opts, host: got.host });
    if (!r) { if (got.lease) got.lease.release(); console.error('[brighttest] --device any: no dev password for the chosen device'); return 2; }
    opts = r;
  }
  console.log('› device run (real Roku)…');
  let dev;
  try { dev = await (deps.buildAndRun || device.buildAndRun)(cfg, opts, { lease: got.lease }); }
  finally { if (got.lease) got.lease.release(); }
  if (dev.timedOut) { console.error('[brighttest] device run timed out'); return 1; }
  const deviceCases = parseRooibosCases(dev.output);

  // Diff.
  const agree = [];
  const diverge = [];
  const deviceOnly = [];
  for (const [key, devPass] of deviceCases) {
    if (headlessCases.has(key)) {
      const hlPass = headlessCases.get(key);
      if (hlPass === devPass) agree.push(key);
      else diverge.push({ key, hlPass, devPass });
    } else {
      deviceOnly.push(key); // node tests + anything excluded headless
    }
  }
  // A crashed test prints no END marker in either lane, so compare the lane verdicts too: one side failed
  // (crash or RESULT: Fail) while the other passed is a divergence even with no per-test mismatch.
  const hlFailed = laneFailures(hl.output, [...headlessCases.values()].filter((v) => !v).length).failed > 0;
  const devFailed = laneFailures(dev.output, [...deviceCases.values()].filter((v) => !v).length).failed > 0;
  if (hlFailed !== devFailed && !diverge.length) diverge.push({ key: '(run result: crashed or failed test)', hlPass: !hlFailed, devPass: !devFailed });
  // BTNet_ suites are headless-only network fixtures (never run on the device): reported as such, not as a divergence.
  const netSuites = new Set(findNetSpecs(cfg).flatMap((x) => x.suites));
  const netOnly = [...headlessCases.keys()].filter((k) => !deviceCases.has(k) && netSuites.has(k.split(' | ')[0]));
  const headlessOnly = [...headlessCases.keys()].filter((k) => !deviceCases.has(k) && !netOnly.includes(k));
  const nodeSpecCount = findNodeSpecs(cfg).length;

  // Report.
  console.log('\n' + '='.repeat(60));
  console.log('  Cross-check: brs-node (headless) vs real device');
  console.log('='.repeat(60));
  console.log(`  agree            : ${agree.length}  (same result in both lanes)`);
  console.log(`  device-only      : ${deviceOnly.length}  (ran on device but not headless)`);
  if (headlessOnly.length) console.log(`  headless-only    : ${headlessOnly.length}  (unexpected — not seen on device)`);
  console.log(`  DIVERGENT        : ${diverge.length}  (headless ≠ device — fidelity risk)`);

  if (diverge.length) {
    console.log('\n  ⚠ Divergences (a test that behaves differently on the simulator vs the device):');
    for (const d of diverge) {
      console.log(`    • ${d.key}`);
      console.log(`        headless=${d.hlPass ? 'PASS' : 'FAIL'}  device=${d.devPass ? 'PASS' : 'FAIL'}`);
    }
  }
  if (netOnly.length) console.log(`  headless-only    : ${netOnly.length}  (BTNet_ network-fixture specs, skipped on the device by design)`);
  if (headlessOnly.length) {
    console.log('\n  ⚠ Ran headless but not on device — often means the device run stopped early after a');
    console.log('    failure (Rooibos halts remaining suites on device). Showing up to 20:');
    for (const k of headlessOnly.slice(0, 20)) console.log(`    • ${k}`);
  }
  console.log('='.repeat(60));

  if (headlessCases.size === 0 || deviceCases.size === 0) {
    console.error('  One of the lanes produced no test results — cannot cross-check.');
    return 1;
  }
  console.log(diverge.length === 0
    ? `  ✓ No divergence. Headless results match the device for all ${agree.length} shared tests.`
    : `  ✗ ${diverge.length} divergent test(s) — headless is not a faithful proxy for these.`);
  console.log(`  (${deviceOnly.length} device-only test(s); ${nodeSpecCount} @SGNode suite(s) — now run headless too via --coverage.)`);
  return diverge.length > 0 ? 1 : 0;
}

module.exports = { run, parseRooibosCases };
