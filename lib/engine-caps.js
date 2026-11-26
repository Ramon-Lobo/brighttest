'use strict';
// Engine capability probe + `doctor --engines` support.
// Runs brs/probes/engine-caps with the resolved brs-cli (SceneGraph on), compares what the engine DOES with what
// its package metadata CLAIMS, and finds spec/component sources that rely on the non-device BRS-02 field.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { engineFor, engineBin } = require('./engines');

// Capability probing deliberately still goes through the engine CLI (brs-cli), not lib/engine-run.js: it needs the
// engine's own identity and the SceneGraph extension, and does not read `deviceInfo`.
const PROBE_DIR = path.join(__dirname, '..', 'brs', 'probes', 'engine-caps');

// Human label per patch id the probe app reports.
const CAP_LABELS = {
  'BRS-01': 'invalid to scalar default',
  'BRS-02': 'Label.forceUpperCase',
  'BRS-03': 'Float element types',
  'BRS-04': 'loadDisplayMode case',
  'BRS-06': 'detached findNode',
  'BRS-07': '--device-data CLI flag',
  'BRS-08': 'CLI colorize cost guard',
  'BRS-09': 'RoFont binary-search ellipsis',
  'BRS-10': 'measuring canvas width 0 after EXIT',
};

// CLI-level patches: they change brs-cli options and console output, not what a script run by the probe app can
// observe, so there is no runtime probe. They are checked from the stamp metadata only (probe column n/a).
// BRS-09/BRS-10 are RoFont timing/exit-path behaviour (ellipsis search cost, measuring after the host sets EXIT);
// they cannot be probed deterministically and safely from a script, so they are metadata-only too.
const METADATA_ONLY = new Set(['BRS-07', 'BRS-08', 'BRS-09', 'BRS-10']);

const NON_DEVICE_NOTE = 'non-device behavior: a real Roku has no Label.forceUpperCase; this spec will not match the device';

// Run the probe app with the resolved brs-node. Returns { ok, caps: {id: 0|1}, ms, error? }.
function runProbe(cfg, opts = {}) {
  const t0 = Date.now();
  let cli;
  try { cli = engineBin('brsNode', cfg, opts); } catch (e) { return { ok: false, caps: {}, ms: 0, error: e.message }; }
  const res = spawnSync(process.execPath, [cli, '-r', '.', path.join('source', 'main.brs')], {
    cwd: PROBE_DIR, encoding: 'utf8', timeout: opts.timeoutMs || 30000, killSignal: 'SIGKILL',
  });
  const ms = Date.now() - t0;
  if (res.error) return { ok: false, caps: {}, ms, error: res.error.code === 'ETIMEDOUT' ? 'probe timed out' : res.error.message };
  const caps = {};
  for (const raw of ((res.stdout || '') + (res.stderr || '')).split(/\r\n|\r|\n/)) {
    const m = raw.replace(/\x1b\[[0-9;]*m/g, '').match(/^\s*CAP\s+(\S+)\s+([01])\s*$/);
    if (m) caps[m[1]] = +m[2];
  }
  if (!Object.keys(caps).length) {
    const tail = ((res.stderr || '') + (res.stdout || '')).trim().split('\n').slice(-3).join(' | ');
    return { ok: false, caps, ms, error: `probe printed no CAP lines${tail ? ` (${tail})` : ''}` };
  }
  return { ok: true, caps, ms };
}

// Compare metadata (eng.caps, from the stamp or UPSTREAM_SINCE) with probe results. Every id either side knows
// about gets a row (CLI-level ids are metadata-only, never a mismatch). A claimed id the probe did not report counts as absent (probe has no evidence for it).
// An unstamped patched-named build has no metadata to contradict: its rows are informational only.
function compareCaps(eng, probe) {
  const metadataKnown = !(eng.flavor === 'patched' && !eng.stamp);
  const ids = [...new Set([...Object.keys(CAP_LABELS), ...eng.caps, ...Object.keys(probe.caps)])].sort();
  const rows = ids.map((id) => {
    const meta = eng.caps.includes(id);
    const cliOnly = METADATA_ONLY.has(id);
    const live = cliOnly ? null : probe.caps[id] === 1;
    return {
      id, label: CAP_LABELS[id] || null, metadata: metadataKnown ? meta : null, probe: live,
      nonDevice: eng.nonDevice.includes(id) || id === 'BRS-02', mismatch: !cliOnly && metadataKnown && meta !== live,
    };
  });
  return { rows, metadataKnown, mismatches: rows.filter((r) => r.mismatch) };
}

const yn = (v) => (v === null ? 'n/a' : v ? 'yes' : 'absent');

// doctor --engines: returns the exit code. out/err are writers (tests); json prints a machine record.
function doctorEngines(cfg, { json = false, out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s), opts = {} } = {}) {
  const brs = engineFor('brsNode', cfg, opts);
  const roo = engineFor('rooibos', cfg, opts);
  const probe = runProbe(cfg, opts);
  const cmp = probe.ok ? compareCaps(brs, probe) : { rows: [], metadataKnown: true, mismatches: [] };
  const code = probe.ok && !cmp.mismatches.length ? 0 : 1;
  if (json) {
    out(JSON.stringify({
      brsNode: { name: brs.name, version: brs.version, flavor: brs.flavor },
      rooibos: { name: roo.name, version: roo.version, flavor: roo.flavor, caps: roo.caps },
      probe: { ok: probe.ok, ms: probe.ms, error: probe.error || null }, metadataKnown: cmp.metadataKnown,
      caps: cmp.rows, mismatches: cmp.mismatches.map((r) => r.id), ok: code === 0,
    }, null, 2) + '\n');
    return code;
  }
  out(`brs-node: ${brs.name}@${brs.version}  flavor: ${brs.flavor}${brs.stamp ? '' : '  (no brighttest stamp)'}\n`);
  out(`rooibos:  ${roo.name}@${roo.version}  flavor: ${roo.flavor}${roo.caps.length ? `  caps: ${roo.caps.join(', ')}` : ''}\n\n`);
  if (!probe.ok) {
    err(`engine-caps probe FAILED: ${probe.error}\n`);
    return 1;
  }
  out(`${'cap'.padEnd(8)}${'metadata'.padEnd(10)}${'probe'.padEnd(8)}note\n`);
  for (const r of cmp.rows) {
    const notes = [r.label, r.nonDevice ? 'NON-DEVICE (brighttest convenience, not on a real Roku)' : null, r.mismatch ? 'MISMATCH' : null].filter(Boolean);
    out(`${r.id.padEnd(8)}${yn(r.metadata).padEnd(10)}${yn(r.probe).padEnd(8)}${notes.join('; ')}\n`);
  }
  out('\n');
  if (!cmp.metadataKnown) out('note: this engine has no brighttest stamp, so metadata cannot be compared; the probe column is the evidence.\n');
  if (cmp.mismatches.length) {
    for (const r of cmp.mismatches) err(`engine-caps MISMATCH ${r.id}: metadata says ${yn(r.metadata)}, probe says ${yn(r.probe)}\n`);
    err('A patch was lost or added without updating the stamp. Reinstall the engine or fix package.json#brighttest.\n');
    return 1;
  }
  out(`probe: ok (${probe.ms} ms); metadata and probe agree\n`);
  return 0;
}

// Find `forceUpperCase` use in project sources. Returns [{ file (rootDir-relative), line }].
function findForceUpperCaseUse(rootDir, stagingDir) {
  const hits = [];
  const skip = new Set(['node_modules', '.git', 'out', 'build', 'dist', 'coverage']);
  const exts = new Set(['.brs', '.bs', '.xml']);
  (function walk(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skip.has(e.name) || e.name.startsWith('.') || (stagingDir && path.resolve(p) === path.resolve(stagingDir))) continue;
        walk(p);
      } else if (exts.has(path.extname(e.name))) {
        let text;
        try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
        text.split(/\r\n|\r|\n/).forEach((l, i) => {
          if (/forceUpperCase/i.test(l)) hits.push({ file: path.relative(rootDir, p).split(path.sep).join('/'), line: i + 1 });
        });
      }
    }
  })(rootDir);
  return hits;
}

// Run-time warning lines (stderr) when the resolved brs-node HAS BRS-02 and the project uses the field.
// Stock engines lack the field, so no warning there. Returns the lines (also written via err).
function warnNonDeviceUse(cfg, { err = (s) => process.stderr.write(s), opts = {} } = {}) {
  let eng;
  try { eng = engineFor('brsNode', cfg, opts); } catch { return []; }
  if (!eng.caps.includes('BRS-02')) return [];
  const lines = findForceUpperCaseUse(cfg.rootDir, cfg.stagingDir)
    .map((h) => `nondevice-field: Label.forceUpperCase used in ${h.file}:${h.line} (${NON_DEVICE_NOTE})`);
  for (const l of lines) err(`${l}\n`);
  return lines;
}

module.exports = { PROBE_DIR, CAP_LABELS, METADATA_ONLY, NON_DEVICE_NOTE, runProbe, compareCaps, doctorEngines, findForceUpperCaseUse, warnNonDeviceUse };
