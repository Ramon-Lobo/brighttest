'use strict';
const coverageHeadless = require('./coverage-headless');
const device = require('./device');
const { findNodeSpecs } = require('./config');

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
async function run(cfg, opts) {
  if (!opts.host || !opts.password) {
    console.error('[roku-test] --cross-check requires --host <ip> and --password <dev-password>');
    return 2;
  }

  console.log('› headless run (brs-node simulator)…');
  const hl = await coverageHeadless.buildAndRun(cfg, opts);
  if (!hl.built) { process.stderr.write(hl.output); console.error('[roku-test] headless build failed'); return 1; }
  const headlessCases = parseRooibosCases(hl.output);

  console.log('› device run (real Roku)…');
  const dev = device.buildAndRun(cfg, opts);
  if (dev.timedOut) { console.error('[roku-test] device run timed out'); return 1; }
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
  const headlessOnly = [...headlessCases.keys()].filter((k) => !deviceCases.has(k));
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
