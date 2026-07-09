'use strict';
const fs = require('fs');
const path = require('path');
const { resolvePackageMain } = require('./tools');

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

// Writes a generated bsconfig for a given lane and returns its path.
//   lane 'device'            → run on hardware, coverage on; extra.lcov → print LCOV to console
//   lane 'headless-coverage' → stock Rooibos on brs-node, coverage on, LCOV, incl. @SGNode node suites
//   lane 'headless-scene'    → stock Rooibos on brs-node, coverage OFF, incl. @SGNode node suites
//                              (the default lane uses this when a project has @SGNode specs)
// extra.lcov (device lane) makes Rooibos print an LCOV block to the console for scraping.
// extra.excludeNodeSpecs drops @SGNode specs from the build (used by --no-sgnode on scene lanes).
function writeBsConfig(cfg, lane, extra = {}) {
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
  // Global-context seeding: `globalFields` (a map of scene-field -> value in brighttest.json) is
  // written to a JSON the rooibos framework reads (pkg:/rooibos_global_seed.json) and applies to the
  // test scene BEFORE constructing @SGNode widgets. A bare widget's getGlobalField(x) reads
  // scene.getField(x); without the real app's globals those reads return invalid and the widget
  // crashes on device (e.g. dot-on-invalid) while constructing. Seeding e.g. { config: {}, user: {} }
  // lets it construct as it would in-app. Injected via a {src,dest} entry so cbs-roku is untouched.
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
    plugins: [resolvePackageMain('@ramonlobo/rooibos-roku')],
    rooibos,
  };
  fs.mkdirSync(staging, { recursive: true });
  const p = path.join(staging, 'bsconfig.json');
  fs.writeFileSync(p, JSON.stringify(bsconfig, null, 2));
  return { bsconfigPath: p, stagingBuild: bsconfig.stagingDir, pkgPath };
}

module.exports = { loadConfig, writeBsConfig, findNodeSpecs };
