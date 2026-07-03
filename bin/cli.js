#!/usr/bin/env node
'use strict';
const { loadConfig } = require('../lib/config');

function parseArgs(argv) {
  const opts = { device: false, junit: null, host: null, password: null, config: null, lcov: null };
  const DEFAULT_LCOV = 'coverage/lcov.info';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--device' || a === '-d') opts.device = true;
    else if (a === '--host') opts.host = argv[++i];
    else if (a === '--password' || a === '--pass') opts.password = argv[++i];
    else if (a === '--junit') opts.junit = argv[++i];
    else if (a === '--config' || a === '-c') opts.config = argv[++i];
    else if (a === '--lcov') { const n = argv[i + 1]; opts.lcov = (n && !n.startsWith('-')) ? argv[++i] : DEFAULT_LCOV; }
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--host=')) opts.host = a.slice(7);
    else if (a.startsWith('--password=')) opts.password = a.slice(11);
    else if (a.startsWith('--junit=')) opts.junit = a.slice(8);
    else if (a.startsWith('--lcov=')) opts.lcov = a.slice(7);
  }
  return opts;
}

const HELP = `
roku-test — unified BrightScript test runner

  Write Rooibos specs once; run them headless (default) or on a Roku device with coverage.

Usage:
  roku-test [--junit <path>] [--config <path>]      Headless run (no device) — default
  roku-test --device --host <ip> --password <pw>    On-device run with code coverage
  roku-test --device --host <ip> --password <pw> --lcov coverage/lcov.info   + write LCOV

Options:
  -d, --device          Run on a Roku device (deploys + runs Rooibos, reports coverage)
      --host <ip>       Roku device IP (device mode)
      --password <pw>   Roku developer password (device mode)
      --lcov [path]     Write an LCOV report from the device run (device mode;
                        default path: coverage/lcov.info)
      --junit <path>    Write a JUnit XML report (headless mode)
  -c, --config <path>   Path to roku-test.json (default: ./roku-test.json)
  -h, --help            Show this help

Config (roku-test.json, all optional):
  { "rootDir": ".", "sourceGlobs": ["manifest","source/**/*","components/**/*"],
    "testsFilePattern": "**/*.spec.bs", "stagingDir": ".roku-test" }
`;

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); process.exit(0); }

  const cfg = loadConfig(process.cwd(), opts.config);
  const lane = opts.device ? require('../lib/device') : require('../lib/headless');
  console.log(`roku-test: ${opts.device ? 'device (coverage)' : 'headless'} lane\n`);
  const code = lane.run(cfg, opts);
  process.exit(code);
}

main();
