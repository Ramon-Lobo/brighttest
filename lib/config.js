// @ts-check
'use strict';
const fs = require('fs');
const path = require('path');
const engines = require('./engines');
const { enginePackageMain } = engines;

// Defaults for the `deviceLease` block of brighttest.json (durations: 90s, 10m, 1h or ms).
const DEVICE_LEASE_DEFAULTS = {
  enabled: true,      // false = same as --no-lease for this project (warns, audited)
  wait: '30m',        // how long a device command queues for the device (BRIGHTTEST_LEASE_WAIT / --wait win)
  maxHold: '60m',     // hard cap on one hold; the holder stops itself 5 s before (exit 77)
  sessionIdle: '10m', // session leases (`device lock`, Phase 2): idle TTL
  sessionMax: '45m',  // session leases: hard cap
  hygiene: 'home',    // 'home' | 'none': Home x2 after acquiring, for `e2e run` and `device with`
  studioIdle: '5m',   // Studio releases after this long without user activity
  studioYield: '60s', // …or after this long when someone is queued
};

// `deviceLease.pool` (validated where the pool is used, so a bad value never breaks a headless run): a list of device hosts (IPv4 or host name, no port or password), at least one, no duplicates. Two
// entries is the supported shape; `--device any` takes the first free one.
function parseLeasePool(v) {
  const bad = (m) => new Error(`deviceLease.pool ${m}`);
  if (!Array.isArray(v)) throw bad('must be a list of device hosts, e.g. ["192.168.1.10", "192.168.1.11"]');
  if (v.length === 0) throw bad('is empty: list at least one device host, or remove the key');
  const out = [];
  v.forEach((h, i) => {
    if (typeof h !== 'string' || !h.trim()) throw bad(`entry ${i + 1} must be a non-empty host string`);
    const t = h.trim().toLowerCase();
    // IPv4 address or host name only: a port, password, list, bracketed or IPv6 address is rejected. The entry is
    // never echoed (it could carry a password).
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(t)) throw bad(`entry ${i + 1} must be a bare IPv4 address or host name (no port, password, list or IPv6 address)`);
    const dup = out.indexOf(t);
    if (dup !== -1) throw bad(`entry ${i + 1} duplicates entry ${dup + 1}`);
    out.push(t);
  });
  return out;
}

// Defaults for the `instrument` block of brighttest.json (lib/instrument/build.js). The rest of the block (exclude,
// net, scene, op, hub, ...) is passed to the instrument plugin as it is.
const INSTRUMENT_DEFAULTS = {
  strict: false,      // true = a "could not instrument" entry fails the build (exit 4); the CI recipe sets it on
};

// Defaults for the `builds` block (build history store, ADR 0052). `dir` null = project or user store; `record` false
// = never write build records; the caps are per store (count and MB of unpinned builds) and per package.
const BUILDS_DEFAULTS = {
  dir: null,
  record: true,
  maxCount: 30,
  maxTotalMB: 1024,
  maxZipMB: 64,
};

// Defaults for the `deviceInfo` block of brighttest.json (COV-02): the device identity the headless engine reports to
// roDeviceInfo. Ultra-like values measured on a Roku Ultra 4850 (design [DV] 2026-11-19-device-verification.md: model
// 4850X, UI resolution FHD 1920x1080, connection WiFiConnection). `osVersion` and `locale` have no written-down
// source, so they stay unset and the engine's own values apply. No secrets belong in this block. The defaults only
// apply when the block sets at least one key: with no `deviceInfo` the headless run is unchanged (engine identity).
const DEVICE_INFO_DEFAULTS = {
  model: '4850X',
  uiResolution: '1080p',
  connectionType: 'WiFiConnection',
};
const DEVICE_INFO_ENUMS = {
  uiResolution: ['480p', '720p', '1080p'],
  connectionType: ['WiredConnection', 'WiFiConnection'],
};
const LOCALE_RE = /^[a-z]{2}_[A-Z]{2}$/;
// The engine's encoded firmware string, e.g. 48G.04E05531A (= 15.0.4 build 5531).
const OS_VERSION_RE = /^[0-9A-Z]{3}\.[0-9]{2}[A-Z][0-9]{5}[A-Z]$/;
const FRIENDLY_NAME_MAX = 256;
const COUNTRY_RE = /^[A-Z]{2}$/;
const DEVICE_INFO_KEYS = ['model', 'osVersion', 'locale', 'uiResolution', 'connectionType', 'friendlyName', 'country'];

// True when the block sets at least one key (an absent or empty block leaves the engine identity alone).
function deviceInfoConfigured(block) {
  return !!block && typeof block === 'object' && !Array.isArray(block) && Object.values(block).some((v) => v != null);
}

// Validates the user's `deviceInfo` block and merges it over the defaults. Every error names the key.
function resolveDeviceInfo(block) {
  if (block == null) return { ...DEVICE_INFO_DEFAULTS };
  if (typeof block !== 'object' || Array.isArray(block)) throw new Error('deviceInfo must be an object');
  for (const k of Object.keys(block)) {
    if (!DEVICE_INFO_KEYS.includes(k)) throw new Error(`deviceInfo.${k} is not a known key (known: ${DEVICE_INFO_KEYS.join(', ')})`);
  }
  for (const k of DEVICE_INFO_KEYS) {
    const v = block[k];
    if (v == null) continue;
    if (typeof v !== 'string' || !v.trim()) throw new Error(`deviceInfo.${k} must be a non-empty string (got ${JSON.stringify(v)})`);
    if (DEVICE_INFO_ENUMS[k] && !DEVICE_INFO_ENUMS[k].includes(v)) {
      throw new Error(`deviceInfo.${k} must be one of ${DEVICE_INFO_ENUMS[k].join(', ')} (got ${JSON.stringify(v)})`);
    }
  }
  if (block.locale != null && !LOCALE_RE.test(block.locale)) throw new Error(`deviceInfo.locale must look like en_US (got ${JSON.stringify(block.locale)})`);
  if (block.country != null && !COUNTRY_RE.test(block.country)) throw new Error(`deviceInfo.country must be a two-letter uppercase country code like US (got ${JSON.stringify(block.country)})`);
  if (block.friendlyName != null && block.friendlyName.length > FRIENDLY_NAME_MAX) throw new Error(`deviceInfo.friendlyName must be at most ${FRIENDLY_NAME_MAX} characters (got ${block.friendlyName.length})`);
  if (block.osVersion != null && !OS_VERSION_RE.test(block.osVersion)) {
    throw new Error(`deviceInfo.osVersion must be the engine's encoded firmware string like 48G.04E05531A (15.0.4 build 5531) (got ${JSON.stringify(block.osVersion)})`);
  }
  const out = { ...DEVICE_INFO_DEFAULTS };
  for (const k of DEVICE_INFO_KEYS) if (block[k] != null) out[k] = block[k].trim();
  return out;
}

// The resolved block as the brs-node engine's `customDeviceData` (a partial of its DeviceInfo): model ->
// deviceModel, osVersion -> firmwareVersion (the engine's encoded firmware string), uiResolution -> displayMode,
// connectionType -> connectionInfo.type, friendlyName -> friendlyName, country -> countryCode.
function toEngineDeviceInfo(di) {
  const out = {};
  if (di.model) out.deviceModel = di.model;
  if (di.osVersion) out.firmwareVersion = di.osVersion;
  if (di.locale) out.locale = di.locale;
  if (di.uiResolution) out.displayMode = di.uiResolution;
  if (di.connectionType) out.connectionInfo = { type: di.connectionType };
  if (di.friendlyName) out.friendlyName = di.friendlyName;
  if (di.country) out.countryCode = di.country;
  return out;
}

// Device lane idle (output-silence) watchdog, seconds: a non-negative integer, 0 = disabled. Accepts a number or a
// numeric string (CLI flag); anything else throws (the CLI reports it before any device work).
function parseIdleTimeout(v, label) {
  const ok = (typeof v === 'number' && Number.isInteger(v) && v >= 0) || (typeof v === 'string' && /^\d+$/.test(v.trim()));
  if (!ok) throw new Error(`${label} must be a non-negative integer number of seconds (0 disables), got ${JSON.stringify(v)}`);
  return Number(v);
}

// `instrument.exclude` is the canonical spelling; top-level `instrumentExclude` is a deprecated alias. Returns the
// deduplicated union (canonical entries first) so the build and the census read one list.
function mergedInstrumentExclude(cfg) {
  const inst = cfg && cfg.instrument && typeof cfg.instrument === 'object' ? cfg.instrument : {};
  const list = (v) => (Array.isArray(v) ? v : []);
  return [...new Set([...list(inst.exclude), ...list(cfg && cfg.instrumentExclude)])];
}

// Typed error for a bad headless `instrument` block. loadConfig never throws it (instrument build, Studio, e2e and
// doctor all call loadConfig); the headless lane calls resolveHeadlessInstrument and reports it (exit 2).
class InstrumentConfigError extends Error {
  constructor(message) { super(message); this.name = 'InstrumentConfigError'; }
}

// `instrument.strictAccept`: globs of excluded files whose `excluded-candidate` report entry does not fail `--strict`.
// Throws InstrumentConfigError when it is not an array of non-empty glob strings.
function validateStrictAccept(v) {
  if (!(Array.isArray(v) && v.every((g) => typeof g === 'string' && g.trim() !== ''))) {
    let shown; try { shown = JSON.stringify(v); } catch { shown = String(v); }
    throw new InstrumentConfigError(`instrument.strictAccept must be an array of non-empty glob strings (got ${shown})`);
  }
  return v;
}
function strictAcceptList(inst) {
  return inst && inst.strictAccept !== undefined ? validateStrictAccept(inst.strictAccept) : [];
}

// Resolves the headless `instrument` block: { enabled, state, net }. `state` is false (off) or the options object
// (`{}` for true or unset) and is only meaningful when `enabled`. `net` follows net-headless.isActive (unchanged by
// `enabled`). Throws InstrumentConfigError on a bad block. opts.instrument === true forces `enabled` for one run.
/** @param {any} cfg @param {{ instrument?: boolean, [k: string]: unknown }} [opts] @returns {import('../types/config').HeadlessInstrument} */
function resolveHeadlessInstrument(cfg, opts = {}) {
  // Validate the block as written in brighttest.json: loadConfig keeps it non-enumerably (the merged block has
  // already replaced bad values with defaults and merged the instrumentExclude alias).
  const raw = cfg && Object.prototype.hasOwnProperty.call(cfg, '_rawInstrument') ? cfg._rawInstrument : (cfg && cfg.instrument);
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const show = (v) => { const j = JSON.stringify(v); return j === undefined ? String(v) : j; };
  const inst = isObj(raw) ? raw : {};
  const enabled = (opts && opts.instrument === true) || inst.enabled === true;
  const net = require('./instrument/net-headless').isActive(cfg, opts || {});
  // Strict only when the run is instrumented: a bad block must not fail a plain headless run. When it is not
  // enabled the problem comes back as `warning` and the run goes on without the block.
  const check = () => {
    if (raw !== undefined && !isObj(raw)) throw new InstrumentConfigError(`instrument must be an object (got ${show(raw)})`);
    if (inst.enabled !== undefined && typeof inst.enabled !== 'boolean') throw new InstrumentConfigError(`instrument.enabled must be true or false (got ${show(inst.enabled)})`);
    if (inst.state !== undefined && typeof inst.state !== 'boolean' && !isObj(inst.state)) throw new InstrumentConfigError(`instrument.state must be true, false or an object (got ${show(inst.state)})`);
    if (isObj(inst.state)) {
      try { require('./instrument/build').validateStateConfig(inst); } catch (e) { throw new InstrumentConfigError(e.message); } // lazy: build.js requires this module
    }
    if (inst.exclude !== undefined && !(Array.isArray(inst.exclude) && inst.exclude.every((g) => typeof g === 'string'))) {
      throw new InstrumentConfigError('instrument.exclude must be an array of glob strings');
    }
    if (inst.strictAccept !== undefined) validateStrictAccept(inst.strictAccept);
  };
  if (!enabled) {
    try { check(); } catch (e) {
      if (!(e instanceof InstrumentConfigError)) throw e;
      return { enabled: false, state: false, net, warning: e.message };
    }
    return { enabled: false, state: inst.state === false ? false : (isObj(inst.state) ? inst.state : {}), net };
  }
  check();
  const state = inst.state === false ? false : (isObj(inst.state) ? inst.state : {});
  if (state === false && !net) {
    throw new InstrumentConfigError('instrument.enabled is on but state is false and the run does not use net: nothing to instrument (net counts as used when a spec calls BTNet_* outside an @ignore suite, or instrument.net is set)');
  }
  return { enabled, state, net };
}

// Loads brighttest.json from the consumer project (or applies sensible defaults).
/** @param {string} cwd @param {string} [configPath] @returns {import('../types/config').BrighttestConfig} */
function loadConfig(cwd, configPath) {
  const defaults = {
    rootDir: '.',
    // Only source/ and components/ are compiled by Roku; manifest is required by bsc.
    sourceGlobs: ['manifest', 'source/**/*', 'components/**/*'],
    testsFilePattern: '**/*.spec.bs',
    stagingDir: '.brighttest',
  };
  const file = configPath || path.join(cwd, 'brighttest.json');
  let cfg = {};
  if (fs.existsSync(file)) {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const merged = /** @type {import('../types/config').BrighttestConfig} */ (Object.assign({}, defaults, cfg)); // defaults + user file; the blocks are filled just below
  // Device lease settings (lib/device-lease.js): a partial block merges over the defaults.
  merged.deviceLease = Object.assign({}, DEVICE_LEASE_DEFAULTS, cfg.deviceLease || {});
  // Instrument build settings (`brighttest instrument build`): a partial block merges over the defaults.
  merged.instrument = Object.assign({}, INSTRUMENT_DEFAULTS, cfg.instrument || {});
  // Build history store settings (lib/builds/store.js): a partial block merges over the defaults.
  merged.builds = Object.assign({}, BUILDS_DEFAULTS, cfg.builds || {});
  const excl = mergedInstrumentExclude(cfg);
  if (excl.length) merged.instrument.exclude = excl;
  // The block as written, for resolveHeadlessInstrument (non-enumerable: not copied, serialized or listed).
  Object.defineProperty(merged, '_rawInstrument', { value: cfg.instrument, enumerable: false, configurable: true });
  // deviceIdleTimeout (seconds, 0 disables): optional; unset keeps the lane default and the stock rooibos argv.
  if (cfg.deviceIdleTimeout != null) merged.deviceIdleTimeout = parseIdleTimeout(cfg.deviceIdleTimeout, 'deviceIdleTimeout');
  // deviceInfo (COV-02): validated whenever present; only set on the merged config when it configures something.
  const deviceInfo = resolveDeviceInfo(cfg.deviceInfo);
  if (deviceInfoConfigured(cfg.deviceInfo)) merged.deviceInfo = deviceInfo; else delete merged.deviceInfo;
  merged.rootDir = path.resolve(cwd, merged.rootDir);
  merged.stagingDir = path.resolve(cwd, merged.stagingDir);
  return merged;
}

// Walk every `*.spec.bs` under cfg.rootDir (skipping node_modules, .brighttest, .git, out) and call
// visit(absolutePath, text). Unreadable directories and files are ignored.
function walkSpecs(cfg, visit) {
  const skip = new Set(['node_modules', '.brighttest', '.git', 'out']);
  (function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(p); }
      else if (e.name.endsWith('.spec.bs')) {
        let text;
        try { text = fs.readFileSync(p, 'utf8'); } catch (err) { continue; }
        visit(p, text);
      }
    }
  })(cfg.rootDir);
}

// Recursively find test spec files that use @SGNode (device/scene-only node suites).
// Returned paths are rootDir-relative (for use as bsc `files` negations).
function findNodeSpecs(cfg) {
  const out = [];
  walkSpecs(cfg, (p, text) => { if (/@SGNode\b/.test(text)) out.push(path.relative(cfg.rootDir, p)); });
  return out;
}

// Bare `@deviceOnly` (patch ROO-05) is not a stock Rooibos annotation: only `@tags("deviceOnly")` is excluded by the
// headless tag filter, so such suites run headless on stock. Returns `rootDir-relative-path:line` for each hit.
function findBareDeviceOnly(cfg) {
  const out = [];
  walkSpecs(cfg, (p, text) => {
    text.split('\n').forEach((line, i) => {
      if (/^\s*@deviceOnly\b/i.test(line)) out.push(`${path.relative(cfg.rootDir, p)}:${i + 1}`);
    });
  });
  return out;
}

// Does the resolved rooibos engine lack patch `id`? Resolver failures answer false (stay silent), like the covKey probe.
function rooibosLacks(cfg, id) {
  try {
    const eng = engines.engineFor('rooibos', cfg);
    return !!eng && Array.isArray(eng.caps) && !eng.caps.includes(id);
  } catch (_) { return false; }
}

// Spec files that use the headless-only network spec API (`BTNet_*`, NET-N-T5). Returns [{ path, suites }] with
// rootDir-relative paths (usable as bsc `files` negations) and the @suite names declared in each file.
const NET_SPEC_RE = /\bBTNet_\w+/;
const MEDIA_SPEC_RE = /\bBTMedia_\w+/;
const STATE_SPEC_RE = /\bBTState_(?:load|seedGlobals)\b/i;
// `findNetSpecs(cfg)` lists every file that mentions BTNet_ (the device lane drops all of them from its build).
// `findNetSpecs(cfg, { runnable: true })` keeps only files that would actually run on a headless lane:
// at least one non-`@ignore`d suite (with the BTNet_ call, or shared code outside every ignored suite's class) remains.
// `testsFilePattern` is not consulted: the Rooibos fork selects spec files with `includeFilters`, not that key.
// Net auto-activation uses the runnable form so an `@ignore`d suite alone does not stage the net runtime.
function findNetSpecs(cfg, opts = {}) {
  const all = findSpecsUsing(cfg, NET_SPEC_RE);
  if (!opts.runnable) return all;
  return all.filter((x) => usesInRunnableSuite(fs.readFileSync(path.join(cfg.rootDir, x.path), 'utf8'), NET_SPEC_RE));
}

// Blank out comments (`'` and `rem`) and string literals, keeping newlines and length, so markers inside them are inert.
function maskCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      out += '"'; i++;
      while (i < src.length && src[i] !== '\n') {
        if (src[i] === '"') { if (src[i + 1] === '"') { out += '  '; i += 2; continue; } out += '"'; i++; break; }
        out += ' '; i++;
      }
    } else if (c === '`') {
      out += '`'; i++;
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\' && i + 1 < src.length) { out += src[i + 1] === '\n' ? ' \n' : '  '; i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') {
          let d = 0;
          while (i < src.length) { const ch = src[i]; out += ch; i++; if (ch === '{') d++; else if (ch === '}' && --d === 0) break; }
          continue;
        }
        out += src[i] === '\n' ? '\n' : ' '; i++;
      }
      if (i < src.length) { out += '`'; i++; }
    } else if (c === "'" || (/^rem\b/i.test(src.slice(i, i + 4)) && /^[ \t]*$/.test(src.slice(src.lastIndexOf('\n', i - 1) + 1, i)))) {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
    } else { out += c; i++; }
  }
  return out;
}

// True when `re` matches code that a headless run executes: split the (masked) file at each `@suite(` annotation
// group; a group containing `@ignore` drops that suite's segment. Code before the first suite is shared.
function usesInRunnableSuite(src, re) {
  const lines = maskCommentsAndStrings(src).split('\n');
  const isAnn = (l) => /^\s*@\w+/.test(l);
  const groups = []; // { start, ignored }
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*@suite\b/i.test(lines[i])) continue;
    let a = i; let b = i;
    while (a > 0 && isAnn(lines[a - 1])) a--;
    while (b + 1 < lines.length && isAnn(lines[b + 1])) b++;
    const ignored = lines.slice(a, b + 1).some((l) => /^\s*@ignore\b/i.test(l));
    if (!groups.length || groups[groups.length - 1].start !== a) groups.push({ start: a, ignored });
    i = b;
  }
  if (!groups.length) return re.test(lines.join('\n'));
  // Lines of an ignored suite are its annotations through `end class`; everything else (code before, between or
  // after suites, helpers, namespaces, runnable suites) can be reached by a suite that runs.
  const dropped = new Array(lines.length).fill(false);
  groups.forEach((g, k) => {
    if (!g.ignored) return;
    const next = k + 1 < groups.length ? groups[k + 1].start : lines.length;
    let end = -1;
    let cls = -1;
    for (let j = g.start; j < next; j++) {
      if (cls < 0 && /^\s*class\b/i.test(lines[j])) cls = j;
      else if (cls >= 0 && /^\s*end\s+class\b/i.test(lines[j])) { end = j; break; }
    }
    // No parsable class body: fall back to dropping through the next suite.
    for (let j = g.start; j <= (end >= 0 ? end : next - 1); j++) dropped[j] = true;
  });
  if (!groups.some((g) => !g.ignored)) return groups.length === 0 && re.test(lines.join('\n'));
  return re.test(lines.filter((_, j) => !dropped[j]).join('\n'));
}

// Spec files that use the headless-only media-state driver (`BTMedia_*`, COV-16).
function findMediaSpecs(cfg) { return findSpecsUsing(cfg, MEDIA_SPEC_RE); }
function findSpecsUsing(cfg, re) {
  const out = [];
  const skip = new Set(['node_modules', '.brighttest', '.git', 'out']);
  (function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(p); }
      else if (e.name.endsWith('.spec.bs')) {
        try {
          const src = fs.readFileSync(p, 'utf8');
          if (re.test(src)) {
            const suites = [...src.matchAll(/@suite\(\s*"([^"]*)"/g)].map((m) => m[1]);
            out.push({ path: path.relative(cfg.rootDir, p).split(path.sep).join('/'), suites });
          }
        } catch (e2) { /* ignore */ }
      }
    }
  })(cfg.rootDir);
  return out;
}

// Minimal glob test (`**`, `*`, `?`) for one POSIX relative path; enough for the sourceGlobs forms apps use.
// `*` and `?` never match `/`; `**/` matches zero or more directories. Backslashes are read as `/`.
function globMatches(glob, rel) {
  const g = String(glob).replace(/\\/g, '/').replace(/^\.\//, '');
  const re = g.split('**/').map((part) => part.split('*').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '[^/]')).join('[^/]*')).join('(?:.*/)?');
  return new RegExp('^' + re + '$').test(rel);
}

// On the headless-scene lane (Rooibos coverage off) a plain source/main.brs keeps its own Main(): the plugin hooks only
// a .bs Main there, so the app's event loop runs instead of the test runner and the run hangs. (With coverage on the plugin
// does hook a plain .brs Main, and the file may define helpers other code needs, so those lanes keep it.) Returns the
// sourceGlobs with `!source/<real name>` appended when that file exists, is compiled and is not already excluded; else the
// same array. Only source/main.brs (any casing) is covered, not a Main in another .brs file. Logged once per run.
const loggedMainExclude = new Set();
function excludePlainMain(cfg, globs, lane) {
  if (lane !== 'headless-scene') return globs;
  let dir = [];
  try { dir = fs.readdirSync(path.join(cfg.rootDir, 'source')); } catch (_) { return globs; }
  // the glob needs the real casing: fs.existsSync is case-insensitive on macOS/Windows but bsc's matcher is not
  const real = dir.find((n) => n.toLowerCase() === 'main.brs');
  if (!real) return globs;
  const rel = 'source/' + real;
  const strs = globs.filter((x) => typeof x === 'string');
  if (strs.some((x) => x.startsWith('!') && globMatches(x.slice(1), rel))) return globs;
  if (!strs.some((x) => !x.startsWith('!') && globMatches(x, rel))) return globs;
  const key = path.resolve(cfg.rootDir) + '\0' + rel;
  if (!loggedMainExclude.has(key)) {
    loggedMainExclude.add(key);
    console.log(`[brighttest] excluded ${rel} from the test build: on this lane (coverage off) Rooibos does not hook a plain .brs Main, so the app's own Main() would run instead of the tests`);
  }
  return [...globs, '!' + rel];
}

// Writes a generated bsconfig for a given lane and returns its path.
//   lane 'device'            → run on hardware, coverage on; extra.lcov → print LCOV to console
//   lane 'headless-coverage' → stock Rooibos on brs-node, coverage on, LCOV, incl. @SGNode node suites
//   lane 'headless-scene'    → stock Rooibos on brs-node, coverage OFF, incl. @SGNode node suites
//                              (the default lane uses this when a project has @SGNode specs)
//   lane 'instrument'        → `brighttest instrument build`: no Rooibos plugin or block; the instrument plugin is
//                              added as an object by lib/instrument/build.js (never passed as a path, so it is one
//                              fresh instance per build); extra.outFile = the temp package path, extra.extraFiles =
//                              generated {src,dest} entries (BT_config.brs); `deploy` is never set
// extra.lcov (device lane) makes Rooibos print an LCOV block to the console for scraping.
// extra.excludeNodeSpecs drops @SGNode specs from the build (used by --no-sgnode on scene lanes).
// extra.instrument = { token, host, port, net, state } (headless lanes) generalizes extra.net.
// extra.net = { token, host, port } (headless lanes, NET-N-T5) adds the instrument plugin (net only) and a generated
// BT_config.brs that points the rewritten roUrlTransfer sites at the in-process hub. The device lane drops every spec
// that uses BTNet_* (headless-only network fixtures) and says so.
function writeBsConfig(cfg, lane, extra = {}) {
  if (lane === 'instrument') return writeInstrumentBsConfig(cfg, extra);
  const staging = path.join(cfg.stagingDir, lane);
  // Both scene lanes boot a real SceneGraph scene and ship a package to brs-node/hardware.
  const scenePackage = lane === 'headless-coverage' || lane === 'headless-scene';
  const coverage = lane === 'device' || lane === 'headless-coverage';
  // rooibos 5.17.0 renamed isRecordingCodeCoverage to codeCoverage and warns on any use of the old key, so write
  // exactly one by engine version. With no resolvable rooibos engine, keep the old key.
  let covKey = 'isRecordingCodeCoverage';
  try { if (engines.supportsOption(engines.engineFor('rooibos', cfg), 'codeCoverage')) covKey = 'codeCoverage'; } catch (_) { /* keep old key */ }
  const rooibos = {
    [covKey]: coverage,
    testsFilePattern: cfg.testsFilePattern,
    // Catch crashes on any scene lane so one bad node test can't abort the whole run.
    catchCrashes: coverage || scenePackage,
    // A test runner should run EVERY suite; without this, one failing suite halts all suites that
    // sort after it (Rooibos's failFast defaults on here), silently hiding the rest of your results.
    failFast: false,
  };
  // Device-only tests: `@deviceOnly` (or `@tags("deviceOnly")`) marks a suite/group/test that only
  // makes sense on hardware. The headless lanes exclude that tag so those tests are skipped there,
  // while the device lane keeps them (they run only on `--device`). `--cross-check` then reports them
  // as device-only rather than a divergence. A `!`-prefixed tag is an exclude in Rooibos.
  if (lane !== 'device') {
    rooibos.tags = ['!deviceOnly'];
    if (rooibosLacks(cfg, 'ROO-05')) {
      for (const hit of findBareDeviceOnly(cfg)) {
        console.warn(`brighttest: ${hit}: bare @deviceOnly needs the patched rooibos (ROO-05) and will run headless on stock; use @tags("deviceOnly")`);
      }
    }
  }
  // Device scrapes LCOV only when asked; the headless-coverage lane always wants it.
  if (coverage && (extra.lcov || lane === 'headless-coverage')) {
    rooibos.printLcov = true;
  }
  // Scene lanes run @SGNode suites by default. --no-sgnode negates the node specs so they're skipped.
  const baseGlobs = excludePlainMain(cfg, cfg.sourceGlobs, lane);
  let files = baseGlobs;
  if (extra.excludeNodeSpecs) {
    files = [...baseGlobs, ...findNodeSpecs(cfg).map((p) => '!' + p)];
  }
  if (lane === 'device') {
    const netSpecs = findNetSpecs(cfg);
    if (netSpecs.length) {
      files = [...files, ...netSpecs.map((x) => '!' + x.path)];
      for (const x of netSpecs) console.log(`[brighttest] skipped (headless-only network fixtures): ${x.path}`);
    }
  }
  // BTMedia_* specs (headless-only media-state driver): the device lane drops them; the headless lanes stage the driver
  // as source/bt/BTMedia.brs (specs opt in with `import "pkg:/source/bt/BTMedia.brs"`). No BTMedia_ spec, no change.
  const mediaSpecs = findMediaSpecs(cfg);
  if (mediaSpecs.length) {
    if (lane === 'device') {
      files = [...files, ...mediaSpecs.map((x) => '!' + x.path)];
      for (const x of mediaSpecs) console.log(`[brighttest] skipped (headless-only media driver): ${x.path}`);
    } else {
      files = [...files, { src: path.join(__dirname, 'spec-api', 'BTMedia.brs'), dest: 'source/bt/BTMedia.brs' }];
      if (lane === 'headless') console.log('[brighttest] note: this lane has no roSGNode (--no-sgnode); BTMedia_ specs need Video/Audio nodes, so run them on the scene lanes (default with @SGNode specs, or --coverage)');
    }
  }
  // BTState_load / BTState_seedGlobals specs (snapshot fixtures, STA-S-T12): every lane stages the helper as
  // source/bt/BTState.brs and ships <root>/fixtures/state/** as pkg:/fixtures/state/. No such spec, no change.
  if (findSpecsUsing(cfg, STATE_SPEC_RE).length) {
    files = [...files, { src: path.join(__dirname, 'spec-api', 'BTState.brs'), dest: 'source/bt/BTState.brs' }];
    if (fs.existsSync(path.join(cfg.rootDir, 'fixtures', 'state'))) {
      // relative POSIX pair (bsc resolves it against rootDir); an absolute path breaks on roots like "C:\\Program Files (x86)"
      files = [...files, { src: 'fixtures/state/**/*', dest: 'fixtures/state' }];
    }
  }
  let netInstrument = null;
  // extra.instrument = { token, host, port, net, state } (headless lanes); extra.net = { token, host, port } is the net-only form.
  const ic = extra.instrument || (extra.net ? { ...extra.net, net: true, state: false } : null);
  if (ic && lane !== 'device') {
    const { renderBtConfig, BT_CONFIG_PKG } = require('./instrument/build'); // lazy: build.js requires this module
    fs.mkdirSync(staging, { recursive: true });
    const cfgSrc = path.join(staging, 'BT_config.brs');
    const userNet = cfg.instrument && cfg.instrument.net;
    const withNet = ic.net !== false;
    const state = ic.state && typeof ic.state === 'object' ? ic.state : (ic.state === true ? {} : false);
    fs.writeFileSync(cfgSrc, renderBtConfig(ic.token, { hub: { host: ic.host || '127.0.0.1', port: ic.port }, net: withNet, scene: !!state, op: !!state, ...(state ? { state } : {}) }));
    files = [...files, { src: cfgSrc, dest: BT_CONFIG_PKG }];
    const { strict, hub, state: _userState, lineMap, files: _files, ...rest } = cfg.instrument || {}; // lineMap and files are for `instrument build` only
    void strict; void hub; void _userState; void lineMap; void _files;
    // With the state agent, keep the injected runtime (source/bt/**, components/bt/**) out of coverage instrumentation.
    // Its agent task threads otherwise report coverage events all run long; in about 1 in 14 --coverage runs the engine
    // then ran out of heap while saving them at the end (a 150-230 s stall, then RUN CRASHED). It is dropped from the
    // LCOV anyway (dropToolRecords). A copy, so the frozen constant is not shared with the serialised bsconfig.
    if (coverage && state) rooibos.coverageExcludedFiles = [.../** @type {any} */ (require('./instrument/plugin')).RUNTIME_COVERAGE_EXCLUDE];
    netInstrument = { ...rest, net: withNet ? (userNet && typeof userNet === 'object' && !Array.isArray(userNet) ? userNet : true) : false, scene: !!state, op: !!state, netSpec: withNet, ...(state ? { state } : {}) };
  }
  // Global-context seeding: `globalFields` (a map of scene-field -> value in brighttest.json) is
  // written to a JSON the rooibos framework reads (pkg:/rooibos_global_seed.json) and applies to the
  // test scene BEFORE constructing @SGNode widgets. A bare widget's getGlobalField(x) reads
  // scene.getField(x); without the real app's globals those reads return invalid and the widget
  // crashes on device (e.g. dot-on-invalid) while constructing. Seeding e.g. { config: {}, user: {} }
  // lets it construct as it would in-app. Injected via a {src,dest} entry so the project is untouched.
  if (cfg.globalFields && typeof cfg.globalFields === 'object' && Object.keys(cfg.globalFields).length) {
    fs.mkdirSync(staging, { recursive: true });
    const seedPath = path.join(staging, 'rooibos_global_seed.json');
    fs.writeFileSync(seedPath, JSON.stringify(cfg.globalFields));
    if (rooibosLacks(cfg, 'ROO-04')) {
      let v = '';
      try { v = `@${engines.engineFor('rooibos', cfg).version}`; } catch (_) { /* no version */ }
      console.warn(`brighttest: rooibos-roku${v} (stock) lacks ROO-04 globalFields seeding; seeds are ignored. Use the patched engines (default).`);
    }
    files = [...files, { src: seedPath, dest: 'rooibos_global_seed.json' }];
  }
  const pkgPath = path.join(staging, 'pkg.zip');
  const bsconfig = {
    rootDir: cfg.rootDir,
    files,
    stagingDir: path.join(staging, 'build'),
    createPackage: lane === 'device' || scenePackage,
    // Known package path so the scene runner can hand the zip to brs-node.
    ...(scenePackage ? { outFile: pkgPath, retainStagingDir: true } : {}),
    // Required for Rooibos @SGNode node tests: BrighterScript auto-links a component's same-named
    // script. Without it, Rooibos's generated <Node>_component.xml never <script>s its own .brs, so
    // the node's init()/rooibosRunSuite observer never registers and node tests hang forever.
    autoImportComponentScript: true,
    // autoImportComponentScript makes existing explicit <script> tags for same-named files redundant;
    // BS1107 warns about each one — always silenced. Projects can add more codes via brighttest.json's
    // `diagnosticFilters` (e.g. 1140 "cannot find function" for @SGNode specs that call a component's
    // own subs — they resolve at runtime inside the generated node but not in the spec's static scope;
    // or 1002 arg-count quirks the device tolerates). Codes are merged with the always-on 1107.
    diagnosticFilters: [...new Set([1107, ...(cfg.diagnosticFilters || [])])],
    // Absolute path so bsc loads the plugin regardless of hoisting / local linking.
    plugins: [enginePackageMain('rooibos', cfg), ...(netInstrument ? [path.join(__dirname, 'instrument', 'plugin.js')] : [])],
    ...(netInstrument ? { instrument: netInstrument } : {}),
    rooibos,
  };
  fs.mkdirSync(staging, { recursive: true });
  const p = path.join(staging, 'bsconfig.json');
  fs.writeFileSync(p, JSON.stringify(bsconfig, null, 2));
  return { bsconfigPath: p, stagingBuild: bsconfig.stagingDir, pkgPath };
}

// FR-PACKAGE-FILES: what the instrument lane packages. `instrument.files` (an array of globs / {src,dest}) when set,
// else everything under rootDir the Roku packager would ship: all files except dotfiles and dot folders, node_modules,
// test specs (source/tests, *.spec.*), tool config that is not part of a channel (brighttest.json, bsconfig.json,
// package.json, package-lock.json), zips, and the staging dir when it sits inside rootDir. This is separate from
// `sourceGlobs`, which keeps selecting the headless lanes' compile set. `instrument.exclude` is NOT subtracted: it only
// stops the plugin rewriting those files, they still ship (a vendored SDK must be in the package to run).
const INSTRUMENT_FILES_IGNORED = ['!**/.*', '!**/.*/**', '!node_modules/**', '!**/node_modules/**', '!source/tests/**', '!**/*.spec.*', '!brighttest.json', '!bsconfig.json', '!package.json', '!package-lock.json', '!**/*.zip'];
function instrumentFiles(cfg) {
  const set = cfg && cfg.instrument && cfg.instrument.files;
  if (Array.isArray(set)) return set;
  const globs = ['**/*', ...INSTRUMENT_FILES_IGNORED];
  const rel = path.relative(path.resolve(cfg.rootDir || '.'), path.resolve(cfg.stagingDir || '.brighttest')).split(path.sep).join('/');
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) globs.push(`!${rel}/**`);
  return globs;
}

// The `instrument` lane bsconfig. It never carries `deploy`; the package goes to extra.outFile (a temp path chosen by
// build.js, moved to `--out` only after the gates pass). The `instrument` block is handed to the plugin as it is.
function writeInstrumentBsConfig(cfg, extra) {
  const staging = path.join(cfg.stagingDir, 'instrument');
  // `strict` is read by build.js, `files` selects the package contents (FR-PACKAGE-FILES): neither is a plugin option
  const { strict, files: instrumentFilesSetting, ...pluginOptions } = cfg.instrument || {};
  void strict; void instrumentFilesSetting;
  const bsconfig = {
    rootDir: cfg.rootDir,
    files: [...(cfg.instrumentFiles || instrumentFiles(cfg)), ...(extra.extraFiles || [])],
    stagingDir: path.join(staging, 'build'),
    createPackage: true,
    outFile: extra.outFile || path.join(staging, 'app.bt-instrumented.zip'),
    // no autoImportComponentScript: the instrumented build must wire scripts exactly as the plain app does
    diagnosticFilters: [...new Set([1107, ...(cfg.diagnosticFilters || [])])],
    plugins: [],
    instrument: pluginOptions,
  };
  fs.mkdirSync(staging, { recursive: true });
  const p = path.join(staging, 'bsconfig.json');
  fs.writeFileSync(p, JSON.stringify(bsconfig, null, 2));
  return { bsconfigPath: p, bsconfig, stagingBuild: bsconfig.stagingDir, pkgPath: bsconfig.outFile };
}

module.exports = { strictAcceptList, validateStrictAccept, loadConfig, instrumentFiles, globMatches, mergedInstrumentExclude, resolveHeadlessInstrument, InstrumentConfigError, parseLeasePool, resolveDeviceInfo, deviceInfoConfigured, toEngineDeviceInfo, DEVICE_INFO_DEFAULTS, parseIdleTimeout, INSTRUMENT_DEFAULTS, BUILDS_DEFAULTS, writeBsConfig, findNodeSpecs, findBareDeviceOnly, findNetSpecs, findMediaSpecs, DEVICE_LEASE_DEFAULTS };
