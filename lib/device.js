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

  // Without LCOV we can stream straight through.
  if (!wantLcov) {
    const res = spawnSync(process.execPath, args, { encoding: 'utf8', stdio: 'inherit' });
    return res.status == null ? 1 : res.status;
  }

  // With LCOV we must capture output to scrape the coverage blocks (then echo it back).
  const res = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = (res.stdout || '') + (res.stderr || '');
  process.stdout.write(out);

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

module.exports = { run, extractLcov };
