'use strict';
const fs = require('fs');
const path = require('path');
const { resolvePackageMain } = require('./tools');

// Loads roku-test.json from the consumer project (or applies sensible defaults).
function loadConfig(cwd, configPath) {
  const defaults = {
    rootDir: '.',
    // Only source/ and components/ are compiled by Roku; manifest is required by bsc.
    sourceGlobs: ['manifest', 'source/**/*', 'components/**/*'],
    testsFilePattern: '**/*.spec.bs',
    stagingDir: '.roku-test',
  };
  const file = configPath || path.join(cwd, 'roku-test.json');
  let cfg = {};
  if (fs.existsSync(file)) {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const merged = Object.assign({}, defaults, cfg);
  merged.rootDir = path.resolve(cwd, merged.rootDir);
  merged.stagingDir = path.resolve(cwd, merged.stagingDir);
  return merged;
}

// Writes a generated bsconfig for a given lane and returns its path.
// extra.lcov (device lane) makes Rooibos print an LCOV block to the console for scraping.
function writeBsConfig(cfg, lane, extra = {}) {
  const staging = path.join(cfg.stagingDir, lane);
  const rooibos = {
    // Coverage instrumentation calls an on-device SceneGraph collector, so it's device-only.
    isRecordingCodeCoverage: lane === 'device',
    testsFilePattern: cfg.testsFilePattern,
    catchCrashes: lane === 'device',
  };
  if (lane === 'device' && extra.lcov) {
    rooibos.printLcov = true;
  }
  const bsconfig = {
    rootDir: cfg.rootDir,
    files: cfg.sourceGlobs,
    stagingDir: path.join(staging, 'build'),
    createPackage: lane === 'device',
    // Required for Rooibos @SGNode node tests: BrighterScript auto-links a component's same-named
    // script. Without it, Rooibos's generated <Node>_component.xml never <script>s its own .brs, so
    // the node's init()/rooibosRunSuite observer never registers and node tests hang forever.
    autoImportComponentScript: true,
    // Absolute path so bsc loads the plugin regardless of hoisting / local linking.
    plugins: [resolvePackageMain('rooibos-roku')],
    rooibos,
  };
  fs.mkdirSync(staging, { recursive: true });
  const p = path.join(staging, 'bsconfig.json');
  fs.writeFileSync(p, JSON.stringify(bsconfig, null, 2));
  return { bsconfigPath: p, stagingBuild: bsconfig.stagingDir };
}

module.exports = { loadConfig, writeBsConfig };
