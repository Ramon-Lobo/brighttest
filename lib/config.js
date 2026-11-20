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

// ---- SPIKE (ENG-T3): generated test scene for stock rooibos-roku (no fork seed support) ----
const SEED_SCENE = 'BrighttestSeedScene';
// Fields must be declared in the scene interface: on stock brs-node 2.7 addFields() with an invalid
// value does not create the field, and setFields() on an undeclared field is a silent no-op.
function sceneXml(fields) {
  const decl = Object.keys(fields).map((k) => `    <field id="${k}" type="${fields[k]}" />`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<component name="${SEED_SCENE}" extends="RooibosScene">
  <script type="text/brightscript" uri="pkg:/components/brighttest/${SEED_SCENE}.brs" />
  <interface>
    <field id="testText" type="string" onChange="onSuiteChange" />
${decl}
  </interface>
</component>
`;
}
function sgType(v) {
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'float';
  return 'assocarray'; // objects, and null (an unset field reads as an empty value, not invalid)
}
function seedFieldTypes(globalFields) {
  const types = {};
  for (const scope of Object.values(globalFields)) {
    if (!scope || typeof scope !== 'object') continue;
    for (const [k, v] of Object.entries(scope)) {
      if (v !== null && v !== undefined) types[k] = sgType(v);
      else if (!types[k]) types[k] = 'assocarray';
    }
  }
  return types;
}
// Stock rooibos-roku creates node-suite nodes with scene.CreateChild(), so there is no hook before the
// node's init(). It does set scene.testText = "Running Suite i of n: <suite name>" just before each
// suite, so the generated scene observes that field and applies the seed for the suite then.
// Scope "*" applies to every suite; a scope named after the suite name or its @SGNode type layers over
// it. Every field named in any scope is reset to the "*" value (or invalid) first, so one suite's seed
// cannot leak into the next.
const SEED_SCENE_BRS = `sub init()
  m.seed = ParseJson(ReadAsciiFile("pkg:/rooibos_global_seed.json"))
  if m.seed = invalid then m.seed = {}
  m.suiteNodes = m.seed["__suiteNodes"]
  if m.suiteNodes = invalid then m.suiteNodes = {}
  m.seed.delete("__suiteNodes")
  m.top.setFields(fieldsFor(""))
end sub

function fieldsFor(suite as string) as object
  out = {}
  for each scope in m.seed
    if type(m.seed[scope]) = "roAssociativeArray"
      for each k in m.seed[scope]
        out[k] = invalid
      end for
    end if
  end for
  if m.seed["*"] <> invalid then out.append(m.seed["*"])
  if suite <> ""
    if m.seed[suite] <> invalid then out.append(m.seed[suite])
    nodeType = m.suiteNodes[suite]
    if nodeType <> invalid and m.seed[nodeType] <> invalid then out.append(m.seed[nodeType])
  end if
  return out
end function

sub onSuiteChange(event as object)
  text = event.getData()
  idx = Instr(1, text, ": ")
  if idx = 0 then return
  m.top.setFields(fieldsFor(Mid(text, idx + 2)))
end sub
`;

// suite name -> @SGNode type, scanned from the specs (the runtime only exposes the suite name).
function suiteNodeMap(cfg) {
  const map = {};
  for (const rel of findNodeSpecs(cfg)) {
    const src = fs.readFileSync(path.join(cfg.rootDir, rel), 'utf8');
    const suite = src.match(/@suite\(\s*"([^"]+)"/i);
    const node = src.match(/@SGNode\(\s*"([^"]+)"/i);
    if (suite && node) map[suite[1]] = node[1];
  }
  return map;
}

function writeSeedScene(staging, globalFields) {
  const dir = path.join(staging, 'seed-scene');
  fs.mkdirSync(dir, { recursive: true });
  const xml = path.join(dir, SEED_SCENE + '.xml');
  const brs = path.join(dir, SEED_SCENE + '.brs');
  fs.writeFileSync(xml, sceneXml(seedFieldTypes(globalFields)));
  fs.writeFileSync(brs, SEED_SCENE_BRS);
  return [
    { src: xml, dest: `components/brighttest/${SEED_SCENE}.xml` },
    { src: brs, dest: `components/brighttest/${SEED_SCENE}.brs` },
  ];
}

// SPIKE (ENG-T3): bare `@deviceOnly` is not a Rooibos annotation (only `@tags("deviceOnly")` is
// excluded by the headless tag filter), so such suites silently run headless. Report file:line hits.
function findBareDeviceOnly(cfg) {
  const out = [];
  const skip = new Set(['node_modules', '.brighttest', '.git', 'out']);
  (function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(p); continue; }
      if (!e.name.endsWith('.spec.bs')) continue;
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*@deviceOnly\b/i.test(line)) out.push(`${path.relative(cfg.rootDir, p)}:${i + 1}`);
      });
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
    for (const hit of findBareDeviceOnly(cfg)) {
      console.warn(`[brighttest] ${hit}: bare @deviceOnly is not a Rooibos annotation and will run headless; use @tags("deviceOnly")`);
    }
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
  // lets it construct as it would in-app. Injected via a {src,dest} entry so the project is untouched.
  if (cfg.globalFields && typeof cfg.globalFields === 'object' && Object.keys(cfg.globalFields).length) {
    fs.mkdirSync(staging, { recursive: true });
    const seedPath = path.join(staging, 'rooibos_global_seed.json');
    const stock = process.env.BRIGHTTEST_ENGINES === 'stock' && scenePackage;
    fs.writeFileSync(seedPath, JSON.stringify(stock ? { ...cfg.globalFields, __suiteNodes: suiteNodeMap(cfg) } : cfg.globalFields));
    files = [...files, { src: seedPath, dest: 'rooibos_global_seed.json' }];
    // SPIKE (ENG-T3): stock rooibos-roku ignores the seed file. With BRIGHTTEST_ENGINES=stock, ship a
    // generated test scene (extends RooibosScene) that applies the seed and point rooibos at it.
    if (stock) {
      const gen = writeSeedScene(staging, cfg.globalFields);
      files = [...files, ...gen];
      rooibos.testSceneName = SEED_SCENE;
    }
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

module.exports = { loadConfig, writeBsConfig, findNodeSpecs, findBareDeviceOnly };
