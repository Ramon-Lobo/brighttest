#!/usr/bin/env node
'use strict';
const { loadConfig } = require('../lib/config');

function parseArgs(argv) {
  const opts = { device: false, coverage: false, junit: null, host: null, password: null, config: null, lcov: null };
  const DEFAULT_LCOV = 'coverage/lcov.info';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--device' || a === '-d') opts.device = true;
    else if (a === '--host') opts.host = argv[++i];
    else if (a === '--password' || a === '--pass') opts.password = argv[++i];
    else if (a === '--junit') opts.junit = argv[++i];
    else if (a === '--config' || a === '-c') opts.config = argv[++i];
    else if (a === '--lcov') { const n = argv[i + 1]; opts.lcov = (n && !n.startsWith('-')) ? argv[++i] : DEFAULT_LCOV; }
    else if (a === '--coverage') opts.coverage = true;
    else if (a === '--no-sgnode' || a === '--skip-sgnode') opts.noSgnode = true;
    else if (a === '--cross-check') opts.crossCheck = true;
    else if (a === '--timeout') opts.timeout = parseInt(argv[++i], 10) || undefined;
    else if (a.startsWith('--timeout=')) opts.timeout = parseInt(a.slice(10), 10) || undefined;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--host=')) opts.host = a.slice(7);
    else if (a.startsWith('--password=')) opts.password = a.slice(11);
    else if (a.startsWith('--junit=')) opts.junit = a.slice(8);
    else if (a.startsWith('--lcov=')) opts.lcov = a.slice(7);
  }
  return opts;
}

// `brighttest skills [install|update|export|list|uninstall] …` — a positional subcommand with its own parser.
const SKILLS_ACTIONS = ['install', 'update', 'export', 'list', 'uninstall'];
function parseSkillsArgs(rest) {
  const opts = { skillsAction: 'install', agent: null, skill: null, out: null, ref: null, skillsDir: null, force: false, help: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (SKILLS_ACTIONS.includes(a)) opts.skillsAction = a;
    else if (a === '--agent') opts.agent = rest[++i];
    else if (a.startsWith('--agent=')) opts.agent = a.slice(8);
    else if (a === '--skill') opts.skill = rest[++i];
    else if (a.startsWith('--skill=')) opts.skill = a.slice(8);
    else if (a === '--out' || a === '-o') opts.out = rest[++i];
    else if (a.startsWith('--out=')) opts.out = a.slice(6);
    else if (a === '--ref') opts.ref = rest[++i];
    else if (a.startsWith('--ref=')) opts.ref = a.slice(6);
    else if (a === '--skills-dir') opts.skillsDir = rest[++i];
    else if (a.startsWith('--skills-dir=')) opts.skillsDir = a.slice(13);
    else if (a === '--force' || a === '-f') opts.force = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

// `brighttest init [--force]`
function parseInitArgs(rest) {
  const opts = { force: false, help: false };
  for (const a of rest) {
    if (a === '--force' || a === '-f') opts.force = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

const INIT_HELP = `
brighttest init — scaffold a project for testing

  Creates brighttest.json, a first spec at source/tests/Example.spec.bs, git-ignore entries, and an npm
  test script. Existing files are kept unless --force is given.

Usage:
  brighttest init [--force]
`;

const SKILLS_HELP = `
brighttest skills — install AI-agent skills for writing Rooibos tests

  Ships a "writing-rooibos-tests" skill (authoring rules, pitfalls, limitations, examples)
  that teaches AI coding agents how to write correct tests for this project.

Usage:
  brighttest skills install   [--agent <a>] [--skill <name>] [--force]   Install into detected agents
  brighttest skills update    [--ref <branch|tag>] [--agent <a>] ...      Pull the latest skills from the repo
  brighttest skills export    [--out <dir>] [--force]                     Dump the raw skill folders
  brighttest skills list                                                  List available skills + detected agents
  brighttest skills uninstall [--agent <a>] [--skill <name>] [--force]    Remove installed skills

Options:
  --agent <a>       Target agent(s): claude, cursor, agents, copilot, windsurf, cline, zed, agentskills,
                    opencode, hermes, or all. Omit to auto-detect from the project.
  --skill <name>    Limit to one skill (default: all). e.g. writing-rooibos-tests
  --ref <ref>       (update) Git branch/tag to fetch from (default: main)
  --skills-dir <d>  (agentskills target) Skill folder root (default: .agents/skills)
  -o, --out <dir>   (export) Destination (default: ./brighttest-skills)
  -f, --force       Overwrite files not created by brighttest
  -h, --help        Show this help

Skills (Agent Skills / agentskills.io format): writing-rooibos-tests, setting-up-brighttest, debugging-failing-tests.

Auto-detection (no --agent) writes to whichever the project already uses: .claude/, .cursor/, .windsurf/,
.clinerules, .rules (Zed), .agents/ (agentskills), AGENTS.md/opencode, .github/ (Copilot). Shared files
(AGENTS.md, .rules, copilot-instructions.md) are updated in place inside a managed block — other content preserved.
`;

const HELP = `
brighttest — unified BrightScript test runner

  Write Rooibos specs once; run them headless (default) or on a Roku device with coverage.

Usage:
  brighttest [--junit <path>] [--config <path>]      Headless run (no device) — runs @SGNode suites too
  brighttest --no-sgnode                             Headless run, skipping @SGNode (faster SceneGraph-off path)
  brighttest --coverage [--lcov <path>] [--junit <p>] Headless run WITH coverage + LCOV (no device)
  brighttest --device --host <ip> --password <pw>    On-device run with code coverage
  brighttest --device --host <ip> --password <pw> --lcov coverage/lcov.info   + write LCOV
  brighttest --cross-check --host <ip> --password <pw>   Diff headless vs device (fidelity check)
  brighttest init                                    Scaffold a project for testing (see: init --help)
  brighttest skills install                          Install AI-agent test-writing skills (see: skills --help)

Options:
  -d, --device          Run on a Roku device (deploys + runs Rooibos, reports coverage)
      --coverage        Headless coverage: runs the Rooibos runner on the brs-node simulator
                        (no device) and writes LCOV. Runs @SGNode node suites too.
      --no-sgnode       Skip @SGNode node suites and use the faster SceneGraph-off driver.
                        (Node suites otherwise run headless by default.)
      --timeout <sec>   Watchdog timeout (headless 300s, device 900s by default)
      --host <ip>       Roku device IP (device mode)
      --password <pw>   Roku developer password (device mode)
      --lcov [path]     Write an LCOV report from the device run (device mode;
                        default path: coverage/lcov.info)
      --junit <path>    Write a JUnit XML report (headless mode)
  -c, --config <path>   Path to brighttest.json (default: ./brighttest.json)
  -h, --help            Show this help

Config (brighttest.json, all optional):
  { "rootDir": ".", "sourceGlobs": ["manifest","source/**/*","components/**/*"],
    "testsFilePattern": "**/*.spec.bs", "stagingDir": ".brighttest" }
`;

async function main() {
  const argv = process.argv.slice(2);

  // Positional subcommands (init, skills). The flag-only lanes below are untouched.
  if (argv[0] === 'init') {
    const iOpts = parseInitArgs(argv.slice(1));
    if (iOpts.help) { console.log(INIT_HELP); process.exit(0); }
    const code = await require('../lib/init').run(null, iOpts);
    process.exit(code);
  }
  if (argv[0] === 'skills') {
    const sOpts = parseSkillsArgs(argv.slice(1));
    if (sOpts.help) { console.log(SKILLS_HELP); process.exit(0); }
    const code = await require('../lib/skills').run(null, sOpts);
    process.exit(code);
  }

  const opts = parseArgs(argv);
  if (opts.help) { console.log(HELP); process.exit(0); }

  const cfg = loadConfig(process.cwd(), opts.config);
  let lane, label;
  if (opts.crossCheck) { lane = require('../lib/cross-check'); label = 'cross-check (headless vs device)'; }
  else if (opts.device) { lane = require('../lib/device'); label = 'device (coverage)'; }
  else if (opts.coverage) { lane = require('../lib/coverage-headless'); label = 'headless coverage'; }
  else { lane = require('../lib/headless'); label = 'headless'; }
  console.log(`brighttest: ${label} lane\n`);
  const code = await lane.run(cfg, opts);
  process.exit(code);
}

main();
