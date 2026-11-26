'use strict';
// Brownfield config merge: compares an existing brighttest.json with what `init --brownfield` requires and returns the
// smallest change that makes it valid and complete. Pure: no file writes here (lib/init.js writes). Also used by the
// adoption-eval scorer (scripts/adopt-eval/t23.js) so the CLI and the score agree on "valid and complete".
//
// Rules: keep every key whose value is valid; add a missing required key with the detected default; replace a value only
// when it has the wrong type; never delete a key; unknown keys pass through untouched. Values that are merely different
// from what detection would propose (sourceGlobs, registrySections, ...) are the user's and are kept.
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;
const strList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const clone = (v) => JSON.parse(JSON.stringify(v));

// defaults: { rootDir, sourceGlobs, testsFilePattern, stagingDir }; sections: registry sections proposed by the census.
function planMerge(cfg, { defaults, sections = [] }) {
  if (!isObj(cfg)) throw new Error('brighttest.json must contain a JSON object');
  const next = clone(cfg);
  const changes = [];
  const note = (kind, key, old, val) => changes.push({ kind, key, old, new: val });
  const ensure = (obj, prefix, key, ok, def, fixer) => {
    const p = prefix + key;
    if (!(key in obj)) { obj[key] = clone(def); note('added', p, undefined, def); return; }
    if (ok(obj[key])) return;
    const fixed = fixer ? fixer(obj[key]) : clone(def);
    const old = obj[key];
    obj[key] = fixed;
    note('changed', p, old, fixed);
  };
  ensure(next, '', 'rootDir', isStr, defaults.rootDir);
  ensure(next, '', 'sourceGlobs', (v) => strList(v), defaults.sourceGlobs, (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : defaults.sourceGlobs));
  ensure(next, '', 'testsFilePattern', isStr, defaults.testsFilePattern);
  ensure(next, '', 'stagingDir', isStr, defaults.stagingDir);
  ensure(next, '', 'instrument', isObj, {});
  const inst = next.instrument;
  ensure(inst, 'instrument.', 'strict', (v) => typeof v === 'boolean', false);
  if ('exclude' in inst) ensure(inst, 'instrument.', 'exclude', strList, [], (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []));
  const stateOk = (v) => {
    if (typeof v === 'boolean') return true;
    if (!isObj(v)) return false;
    try { require('./instrument/build').validateStateConfig({ state: v }); } catch (e) { return false; }
    return true;
  };
  ensure(inst, 'instrument.', 'state', stateOk, { registrySections: sections });
  if (isObj(inst.state)) ensure(inst.state, 'instrument.state.', 'registrySections', strList, sections);
  return { next, changes };
}

const show = (v) => (v === undefined ? '(absent)' : JSON.stringify(v));
const formatChange = (c) => `${c.kind} ${c.key}: ${show(c.old)} -> ${show(c.new)}`;

// Indentation of an existing file (first indented line), default 2 spaces; keeps a trailing newline if there was one.
function serialize(next, raw) {
  const m = /^([ \t]+)\S/m.exec(raw);
  const indent = m ? m[1] : 2;
  return JSON.stringify(next, null, indent) + (raw === '' || /\n$/.test(raw) ? '\n' : '');
}

// Scorer helper: invalid-or-missing paths of `cfg` per the same rules (empty list = valid and complete).
function validateBrownfield(cfg, defaults) {
  try { return planMerge(cfg, { defaults }).changes; } catch (e) { return [{ kind: 'error', key: '(root)', old: cfg, new: undefined, message: e.message }]; }
}

// Scorer helper: every part of `before` that was valid must be deep-equal in `after`. Returns the paths that were altered.
function alteredValidKeys(before, after, defaults) {
  const bad = validateBrownfield(before, defaults).map((c) => c.key);
  const out = [];
  const walk = (a, b, p) => {
    if (bad.includes(p)) return;
    if (isObj(a) && bad.some((k) => k.startsWith(p + '.'))) {
      for (const k of Object.keys(a)) walk(a[k], isObj(b) ? b[k] : undefined, p ? `${p}.${k}` : k);
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(p);
  };
  if (isObj(before)) for (const k of Object.keys(before)) walk(before[k], isObj(after) ? after[k] : undefined, k);
  return out;
}

module.exports = { planMerge, formatChange, serialize, validateBrownfield, alteredValidKeys };
