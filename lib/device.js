'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { writeBsConfig } = require('./config');
const { resolveBin } = require('./tools');

// Extract a clean lcov.info from Rooibos's console output (printLcov=true prints TN:/SF:/DA:/LF:/LH:/
// end_of_record blocks verbatim). Framework-injected records (…/rooibos/…) are dropped.
function extractLcov(output) {
  const records = [];
  let cur = [];
  let sf = null;
  let inRec = false;
  for (const raw of output.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
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

// Device lane: build with coverage ON and let the stock Rooibos CLI deploy + run on hardware.
function run(cfg, opts) {
  if (!opts.host || !opts.password) {
    console.error('[roku-test] --device requires --host <ip> and --password <dev-password>');
    return 2;
  }
  const wantLcov = !!opts.lcov;
  const { bsconfigPath } = writeBsConfig(cfg, 'device', { lcov: wantLcov });
  const rooibos = resolveBin('rooibos-roku', 'rooibos');
  const args = [rooibos, `--project=${bsconfigPath}`, `--host=${opts.host}`, `--password=${opts.password}`];

  // Watchdog: a misconfigured node test (or an unreachable device) can otherwise hang forever.
  const timeoutMs = (opts.timeout || 900) * 1000; // default 15 min
  const baseOpts = { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' };

  // Without LCOV we can stream straight through.
  if (!wantLcov) {
    const res = spawnSync(process.execPath, args, { ...baseOpts, stdio: 'inherit' });
    if (timedOut(res)) {
      console.error(`\n[roku-test] device run timed out after ${opts.timeout || 900}s and was killed. ` +
        `A node test may never have signalled completion (m.done()?), or the device was unreachable.`);
      return 1;
    }
    return res.status == null ? 1 : res.status;
  }

  // With LCOV we must capture output to scrape the coverage blocks (then echo it back).
  const res = spawnSync(process.execPath, args, { ...baseOpts, maxBuffer: 64 * 1024 * 1024 });
  const out = (res.stdout || '') + (res.stderr || '');
  process.stdout.write(out);
  if (timedOut(res)) {
    console.error(`\n[roku-test] device run timed out after ${opts.timeout || 900}s and was killed.`);
    return 1;
  }

  const { text, count } = extractLcov(out);
  if (text) {
    const dest = path.resolve(opts.lcov);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
    console.log(`\n[roku-test] LCOV written: ${opts.lcov}  (${count} file record(s))`);
  } else {
    console.error('\n[roku-test] --lcov requested but no LCOV output found in the device run.');
    console.error('            (Is coverage enabled and did the tests actually run on the device?)');
    if (res.status === 0) return 1; // treat missing coverage as a failure when explicitly requested
  }
  return res.status == null ? 1 : res.status;
}

// Build + run on the device, capturing raw Rooibos output (used by the cross-check lane).
function buildAndRun(cfg, opts) {
  const { bsconfigPath } = writeBsConfig(cfg, 'device', { lcov: false });
  const rooibos = resolveBin('rooibos-roku', 'rooibos');
  const args = [rooibos, `--project=${bsconfigPath}`, `--host=${opts.host}`, `--password=${opts.password}`];
  const res = spawnSync(process.execPath, args, {
    encoding: 'utf8', timeout: (opts.timeout || 900) * 1000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
  });
  return { output: (res.stdout || '') + (res.stderr || ''), status: res.status, timedOut: timedOut(res) };
}

module.exports = { run, extractLcov, buildAndRun };
