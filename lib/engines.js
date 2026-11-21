'use strict';
// Engine resolution: which brs-node / rooibos package brighttest runs against, in one place.
// Patched builds (`@ramonlobo/*`, stamped with a `brighttest` block in package.json) are the default;
// stock upstream packages are opt-in or the fallback for `auto`. See design fork-strategy.md section 5.3 / 6.1.
const fs = require('fs');
const path = require('path');

const CANDIDATES = {
  brsNode: { patched: '@ramonlobo/brs-node', stock: 'brs-node', bin: 'brs-cli', label: 'brs-node' },
  rooibos: { patched: '@ramonlobo/rooibos-roku', stock: 'rooibos-roku', bin: 'rooibos', label: 'rooibos' },
};

// Patch id -> first upstream version that contains it, per engine kind. Filled in when an upstream PR
// is released; a stock engine at or above that version has the capability. Empty until then.
const UPSTREAM_SINCE = { brsNode: {}, rooibos: {} };

// Flags a rooibos CLI accepts, by first stock version that has them (stamped builds may list them in
// `brighttest.flags`). Used to pass an optional flag only when the engine supports it (ENG-T14).
const FLAG_SINCE = { rooibos: { 'coverage-dir': '5.17.0' } };

class EngineError extends Error {
  constructor(message, code) { super(message); this.name = 'EngineError'; this.code = code; }
}

// Minimal x.y.z comparator (prerelease tags ignored). Returns -1, 0 or 1.
function cmpVersion(a, b) {
  const pa = String(a).split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

function validNames() {
  return Object.values(CANDIDATES).flatMap((c) => [c.patched, c.stock]);
}

function searchPaths(opts) {
  return (opts && opts.paths) || [process.cwd(), __dirname, path.join(__dirname, '..')];
}

function findPackage(name, paths) {
  try {
    const pkgJson = require.resolve(`${name}/package.json`, { paths });
    return { name, dir: path.dirname(pkgJson), pkg: JSON.parse(fs.readFileSync(pkgJson, 'utf8')) };
  } catch { return null; }
}

function capabilities(kind, pkg, upstreamSince) {
  const stamp = pkg.brighttest && typeof pkg.brighttest === 'object' ? pkg.brighttest : null;
  if (stamp) {
    return {
      caps: Object.keys(stamp.patches || {}).filter((id) => stamp.patches[id]),
      nonDevice: Array.isArray(stamp.nonDevice) ? [...stamp.nonDevice] : [],
      stamp,
    };
  }
  const table = (upstreamSince || UPSTREAM_SINCE)[kind] || {};
  const caps = Object.keys(table).filter((id) => cmpVersion(table[id], pkg.version) <= 0);
  return { caps, nonDevice: [], stamp: null };
}

// Does this resolved engine's CLI accept `flag`? A stamp's `flags` list wins; otherwise the version table.
function supportsFlag(eng, flag) {
  const stamp = eng && eng.stamp;
  if (stamp && Array.isArray(stamp.flags)) return stamp.flags.includes(flag);
  const since = (FLAG_SINCE[eng && eng.kind] || {})[flag];
  return !!since && cmpVersion(eng.version, since) >= 0;
}

// Decide the mode for one kind. Precedence: BRIGHTTEST_ENGINES (env) beats cfg.engines[kind]; default auto.
function engineMode(kind, { env = process.env, cfg } = {}) {
  const fromEnv = env.BRIGHTTEST_ENGINES && String(env.BRIGHTTEST_ENGINES).trim();
  const fromCfg = cfg && cfg.engines && cfg.engines[kind];
  if (fromEnv) {
    const overrides = fromCfg && fromCfg !== fromEnv ? fromCfg : null;
    return { mode: fromEnv, source: 'env', overrides };
  }
  if (fromCfg) return { mode: String(fromCfg), source: 'config', overrides: null };
  return { mode: 'auto', source: 'default', overrides: null };
}

const memo = new Map();
function resetEngines() { memo.clear(); }

// resolveEngine(kind, mode = 'auto', opts) -> { kind, name, dir, version, flavor, caps, nonDevice, stamp, bin }
// mode: 'auto' (patched, then stock) | 'patched' | 'stock' | an exact package name from CANDIDATES.
// opts: { paths, upstreamSince } (tests). Memoized per process unless opts.paths is given.
function resolveEngine(kind, mode = 'auto', opts = {}) {
  const c = CANDIDATES[kind];
  if (!c) throw new EngineError(`unknown engine kind '${kind}' (expected: ${Object.keys(CANDIDATES).join(', ')})`, 'ENGINE_KIND');
  const key = `${kind}|${mode}`;
  if (!opts.paths && memo.has(key)) return memo.get(key);

  let order;
  if (mode === 'auto') order = [c.patched, c.stock];
  else if (mode === 'patched') order = [c.patched];
  else if (mode === 'stock') order = [c.stock];
  else if (validNames().includes(mode)) order = [mode];
  else {
    throw new EngineError(
      `unknown engine '${mode}' for ${c.label}. Valid values: auto, patched, stock, ${validNames().join(', ')}.`, 'ENGINE_UNKNOWN');
  }

  const paths = searchPaths(opts);
  let hit = null;
  for (const name of order) { hit = findPackage(name, paths); if (hit) break; }
  if (!hit) {
    const tried = order.join(', ');
    const hint = mode === 'stock' ? `npm i ${c.stock}` : mode === 'patched' || mode === 'auto' ? `npm i ${c.patched}` : `npm i ${mode}`;
    throw new EngineError(
      `${c.label} engine not found (mode '${mode}', looked for: ${tried}). Install it with: ${hint}`, 'ENGINE_MISSING');
  }
  const stamped = !!(hit.pkg.brighttest && typeof hit.pkg.brighttest === 'object');
  const cap = capabilities(kind, hit.pkg, opts.upstreamSince);
  const res = {
    kind, name: hit.name, dir: hit.dir, version: hit.pkg.version,
    flavor: stamped || hit.name === c.patched ? 'patched' : 'stock',
    caps: cap.caps, nonDevice: cap.nonDevice, stamp: cap.stamp, bin: c.bin,
  };
  if (!opts.paths) memo.set(key, res);
  return res;
}

// Resolve for a loaded brighttest config (+ env). Returns the engine with `modeInfo` attached.
function engineFor(kind, cfg, opts = {}) {
  const m = engineMode(kind, { env: opts.env, cfg });
  const eng = resolveEngine(kind, m.mode, opts);
  return Object.assign({}, eng, { modeInfo: m });
}

function engineBin(kind, cfg, opts) {
  const eng = engineFor(kind, cfg, opts);
  const pkgJson = path.join(eng.dir, 'package.json');
  const bin = JSON.parse(fs.readFileSync(pkgJson, 'utf8')).bin;
  const rel = typeof bin === 'string' ? bin : bin[eng.bin] || bin[eng.name] || Object.values(bin)[0];
  return path.join(eng.dir, rel);
}

function enginePackageMain(kind, cfg, opts) {
  const eng = engineFor(kind, cfg, opts);
  return require.resolve(eng.name, { paths: [eng.dir, ...searchPaths(opts)] });
}

function describe(eng) {
  const id = eng.kind === 'brsNode' ? `${eng.name}@${eng.version}` : `rooibos ${eng.version}`;
  let flavor;
  if (eng.flavor === 'stock') flavor = eng.caps.length ? `stock; upstream has ${eng.caps.join(', ')}` : 'stock';
  else {
    const dev = eng.caps.filter((id2) => !eng.nonDevice.includes(id2));
    const parts = [`patched: ${dev.length ? dev.join(', ') : 'none'}`];
    if (eng.nonDevice.length) parts.push(`non-device: ${eng.nonDevice.join(', ')}`);
    flavor = parts.join('; ');
  }
  const note = eng.modeInfo && eng.modeInfo.overrides ? `, env overrides config '${eng.modeInfo.overrides}'` : '';
  return `${id} (${flavor}${note})`;
}

// One line: `engine: @ramonlobo/brs-node@2.7.0-bt.1 (patched: BRS-01, BRS-03; non-device: BRS-02) · rooibos 5.17.0-bt.1 (patched: ...)`
function formatBanner(engines) {
  return `engine: ${engines.map(describe).join(' · ')}`;
}

let bannerPrinted = false;
function printBanner(cfg, out = (s) => process.stdout.write(s), opts = {}) {
  if (bannerPrinted) return null;
  const line = formatBanner([engineFor('brsNode', cfg, opts), engineFor('rooibos', cfg, opts)]);
  bannerPrinted = true;
  out(`${line}\n`);
  return line;
}
function resetBanner() { bannerPrinted = false; }

module.exports = {
  CANDIDATES, UPSTREAM_SINCE, FLAG_SINCE, supportsFlag, EngineError, cmpVersion, engineMode, resolveEngine, engineFor,
  engineBin, enginePackageMain, formatBanner, printBanner, resetEngines, resetBanner,
};
