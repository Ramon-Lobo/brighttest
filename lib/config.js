'use strict';
const fs = require('fs');
const path = require('path');
const { enginePackageMain } = require('./engines');

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
const DEVICE_INFO_KEYS = ['model', 'osVersion', 'locale', 'uiResolution', 'connectionType'];

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
  if (block.osVersion != null && !OS_VERSION_RE.test(block.osVersion)) {
    throw new Error(`deviceInfo.osVersion must be the engine's encoded firmware string like 48G.04E05531A (15.0.4 build 5531) (got ${JSON.stringify(block.osVersion)})`);
  }
  const out = { ...DEVICE_INFO_DEFAULTS };
  for (const k of DEVICE_INFO_KEYS) if (block[k] != null) out[k] = block[k].trim();
  return out;
}

// The resolved block as the brs-node engine's `customDeviceData` (a partial of its DeviceInfo): model ->
// deviceModel, osVersion -> firmwareVersion (the engine's encoded firmware string), uiResolution -> displayMode,
// connectionType -> connectionInfo.type.
function toEngineDeviceInfo(di) {
  const out = {};
  if (di.model) out.deviceModel = di.model;
  if (di.osVersion) out.firmwareVersion = di.osVersion;
  if (di.locale) out.locale = di.locale;
  if (di.uiResolution) out.displayMode = di.uiResolution;
  if (di.connectionType) out.connectionInfo = { type: di.connectionType };
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

// Loads brighttest.json from the consumer project (or applies sensible defaults).
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
  const merged = Object.assign({}, defaults, cfg);
  // Device lease settings (lib/device-lease.js): a partial block merges over the defaults.
  merged.deviceLease = Object.assign({}, DEVICE_LEASE_DEFAULTS, cfg.deviceLease || {});
  // Instrument build settings (`brighttest instrument build`): a partial block merges over the defaults.
  merged.instrument = Object.assign({}, INSTRUMENT_DEFAULTS, cfg.instrument || {});
  const excl = mergedInstrumentExclude(cfg);
  if (excl.length) merged.instrument.exclude = excl;
  // deviceIdleTimeout (seconds, 0 disables): optional; unset keeps the lane default and the stock rooibos argv.
  if (cfg.deviceIdleTimeout != null) merged.deviceIdleTimeout = parseIdleTimeout(cfg.deviceIdleTimeout, 'deviceIdleTimeout');
  // deviceInfo (COV-02): validated whenever present; only set on the merged config when it configures something.
  const deviceInfo = resolveDeviceInfo(cfg.deviceInfo);
  if (deviceInfoConfigured(cfg.deviceInfo)) merged.deviceInfo = deviceInfo; else delete merged.deviceInfo;
  merged.rootDir = path.resolve(cwd, merged.rootDir);
  merged.stagingDir = path.resolve(cwd, merged.stagingDir);
  return merged;
}

// Recursively find test spec files that use @SGNode (device/scene-only node suites).
// Returned paths are rootDir-relative (for use as bsc `files` negations).
function findNodeSpecs(cfg) {
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
          if (/@SGNode\b/.test(fs.readFileSync(p, 'utf8'))) {
            out.push(path.relative(cfg.rootDir, p));
          }
        } catch (e) { /* ignore */ }
      }
    }
  })(cfg.rootDir);
  return out;
}

// Spec files that use the headless-only network spec API (`BTNet_*`, NET-N-T5). Returns [{ path, suites }] with
// rootDir-relative paths (usable as bsc `files` negations) and the @suite names declared in each file.
const NET_SPEC_RE = /\bBTNet_\w+/;
const MEDIA_SPEC_RE = /\bBTMedia_\w+/;
const STATE_SPEC_RE = /\bBTState_(?:load|seedGlobals)\b/i;
function findNetSpecs(cfg) { return findSpecsUsing(cfg, NET_SPEC_RE); }
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
// extra.net = { token, host, port } (headless lanes, NET-N-T5) adds the instrument plugin (net only) and a generated
// BT_config.brs that points the rewritten roUrlTransfer sites at the in-process hub. The device lane drops every spec
// that uses BTNet_* (headless-only network fixtures) and says so.
function writeBsConfig(cfg, lane, extra = {}) {
  if (lane === 'instrument') return writeInstrumentBsConfig(cfg, extra);
  const staging = path.join(cfg.stagingDir, lane);
  // Both scene lanes boot a real SceneGraph scene and ship a package to brs-node/hardware.
  const scenePackage = lane === 'headless-coverage' || lane === 'headless-scene';
  const coverage = lane === 'device' || lane === 'headless-coverage';
  const rooibos = {
    isRecordingCodeCoverage: coverage,
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
  }
  // Device scrapes LCOV only when asked; the headless-coverage lane always wants it.
  if (coverage && (extra.lcov || lane === 'headless-coverage')) {
    rooibos.printLcov = true;
  }
  // Scene lanes run @SGNode suites by default. --no-sgnode negates the node specs so they're skipped.
  let files = cfg.sourceGlobs;
  if (extra.excludeNodeSpecs) {
    files = [...cfg.sourceGlobs, ...findNodeSpecs(cfg).map((p) => '!' + p)];
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
  if (extra.net && lane !== 'device') {
    const { renderBtConfig, BT_CONFIG_PKG } = require('./instrument/build'); // lazy: build.js requires this module
    fs.mkdirSync(staging, { recursive: true });
    const cfgSrc = path.join(staging, 'BT_config.brs');
    const userNet = cfg.instrument && cfg.instrument.net;
    fs.writeFileSync(cfgSrc, renderBtConfig(extra.net.token, { hub: { host: extra.net.host || '127.0.0.1', port: extra.net.port }, net: true, scene: false, op: false }));
    files = [...files, { src: cfgSrc, dest: BT_CONFIG_PKG }];
    const { strict, hub, state, lineMap, ...rest } = cfg.instrument || {}; // lineMap is for `instrument build` only
    void strict; void hub; void state; void lineMap;
    netInstrument = { ...rest, net: userNet && typeof userNet === 'object' && !Array.isArray(userNet) ? userNet : true, scene: false, op: false, netSpec: true };
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

// The `instrument` lane bsconfig. It never carries `deploy`; the package goes to extra.outFile (a temp path chosen by
// build.js, moved to `--out` only after the gates pass). The `instrument` block is handed to the plugin as it is.
function writeInstrumentBsConfig(cfg, extra) {
  const staging = path.join(cfg.stagingDir, 'instrument');
  const { strict, ...pluginOptions } = cfg.instrument || {}; // `strict` is read by build.js, not by the plugin
  void strict;
  const bsconfig = {
    rootDir: cfg.rootDir,
    files: [...cfg.sourceGlobs, ...(extra.extraFiles || [])],
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

module.exports = { loadConfig, mergedInstrumentExclude, parseLeasePool, resolveDeviceInfo, deviceInfoConfigured, toEngineDeviceInfo, DEVICE_INFO_DEFAULTS, parseIdleTimeout, INSTRUMENT_DEFAULTS, writeBsConfig, findNodeSpecs, findNetSpecs, findMediaSpecs, DEVICE_LEASE_DEFAULTS };
