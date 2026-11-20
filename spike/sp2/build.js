'use strict';
// Driver: node build.js <rootDir> <outDir> [--plugin] [--coverage] [--tests] [--main] [--zip]
// Builds with bsc's ProgramBuilder; prints diagnostics and plugin stats. Mirrors lib/config.js writeBsConfig.
const path = require('path');
const { ProgramBuilder } = require('brighterscript');
const a = process.argv.slice(2);
const flag = (f) => a.includes(f);
const [rootDir, outDir] = a.filter((x, i) => !x.startsWith('--') && a[i - 1] !== '--extra').map((p) => path.resolve(p));
const files = ['manifest', 'source/**/*', 'components/**/*', 'certs/**/*'];
if (!flag('--main')) files.splice(2, 0, '!source/main.brs');
if (!flag('--tests')) files.push('!source/tests/**');
const xi = a.indexOf('--extra'); if (xi >= 0) { const d = path.resolve(a[xi + 1]); files.push({ src: d + '/**/*.bs', dest: 'source/tests/extra/' }); }
const plugins = [];
if (flag('--tests') || flag('--coverage')) plugins.push(require.resolve('@ramonlobo/rooibos-roku'));
if (flag('--plugin')) { if (flag('--bt-first')) plugins.unshift(path.join(__dirname, 'plugin.js')); else plugins.push(path.join(__dirname, 'plugin.js')); }
(async () => {
  const pb = new ProgramBuilder();
  const cfg = {
    cwd: rootDir, rootDir, files, stagingDir: path.join(outDir, 'build'), createPackage: flag('--zip'),
    outFile: path.join(outDir, 'pkg.zip'), retainStagingDir: true, autoImportComponentScript: true,
    diagnosticFilters: [1107, 1140], plugins, logLevel: 'error',
    sourceMap: false,
    rooibos: { ...(flag('--cov-exclude') ? { coverageExcludedFiles: ['**/source/bt/**', '**/components/bt/**'] } : {}), isRecordingCodeCoverage: flag('--coverage'), testsFilePattern: '**/*.spec.bs', catchCrashes: true, failFast: false, printLcov: flag('--coverage'), tags: ['!deviceOnly'] },
  };
  await pb.run(cfg);
  const d = pb.program.getDiagnostics().filter((x) => x.severity === 1);
  console.log(JSON.stringify({ errors: d.length, sample: d.slice(0, 8).map((x) => `${x.code} ${x.file.pkgPath}:${(x.range && x.range.start.line + 1)} ${x.message}`), stats: global.__BT_STATS || null }));
})().catch((e) => { console.error(e); process.exit(1); });
