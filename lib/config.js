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

// Defaults for the `instrument` block of brighttest.json (lib/instrument/build.js). The rest of the block (exclude,
// net, scene, op, hub, ...) is passed to the instrument plugin as it is.
const INSTRUMENT_DEFAULTS = {
  strict: false,      // true = a "could not instrument" entry fails the build (exit 4); the CI recipe sets it on
};

// Device lane idle (output-silence) watchdog, seconds: a non-negative integer, 0 = disabled. Accepts a number or a
// numeric string (CLI flag); anything else throws (the CLI reports it before any device work).
function parseIdleTimeout(v, label) {
  const ok = (typeof v === 'number' && Number.isInteger(v) && v >= 0) || (typeof v === 'string' && /^\d+$/.test(v.trim()));
  if (!ok) throw new Error(`${label} must be a non-negative integer number of seconds (0 disables), got ${JSON.stringify(v)}`);
  return Number(v);
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
  // deviceIdleTimeout (seconds, 0 disables): optional; unset keeps the lane default and the stock rooibos argv.
  if (cfg.deviceIdleTimeout != null) merged.deviceIdleTimeout = parseIdleTimeout(cfg.deviceIdleTimeout, 'deviceIdleTimeout');
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
function findNetSpecs(cfg) {
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
          if (NET_SPEC_RE.test(src)) {
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
  let netInstrument = null;
  if (extra.net && lane !== 'device') {
    const { renderBtConfig, BT_CONFIG_PKG } = require('./instrument/build'); // lazy: build.js requires this module
    fs.mkdirSync(staging, { recursive: true });
    const cfgSrc = path.join(staging, 'BT_config.brs');
    const userNet = cfg.instrument && cfg.instrument.net;
    fs.writeFileSync(cfgSrc, renderBtConfig(extra.net.token, { hub: { host: extra.net.host || '127.0.0.1', port: extra.net.port }, net: true, scene: false, op: false }));
    files = [...files, { src: cfgSrc, dest: BT_CONFIG_PKG }];
    const { strict, hub, state, ...rest } = cfg.instrument || {};
    void strict; void hub; void state;
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

module.exports = { loadConfig, parseIdleTimeout, INSTRUMENT_DEFAULTS, writeBsConfig, findNodeSpecs, findNetSpecs, DEVICE_LEASE_DEFAULTS };
