#!/usr/bin/env node
'use strict';
const { loadConfig } = require('../lib/config');

// Prompt a line from the terminal; `hidden` masks the typed characters (for passwords).
function askLine(q, hidden = false) {
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => rl.output.write(s.includes(q) || s.includes('\n') ? s : '*');
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); });
  });
}

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

// `brighttest e2e [run|inspect] <flow…> [options]` — the on-device UI test lane.
const E2E_ACTIONS = ['run', 'inspect', 'record', 'stamp'];
const SCREENSHOT_MODES = ['all', 'failure', 'off'];
function parseE2eArgs(rest) {
  const opts = {
    e2eAction: 'run', flows: [], host: null, password: null, app: null,
    timeout: undefined, screenshots: null, screenshotsMode: 'all', out: null,
    contentIds: null, mediaType: null, video: null, help: false,
    sel: {}, assert: null, field: null,
  };
  const splitList = (v) => String(v).split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (i === 0 && E2E_ACTIONS.includes(a)) opts.e2eAction = a;
    else if (a === '--host') opts.host = rest[++i];
    else if (a.startsWith('--host=')) opts.host = a.slice(7);
    else if (a === '--password' || a === '--pass') opts.password = rest[++i];
    else if (a.startsWith('--password=')) opts.password = a.slice(11);
    else if (a === '--app') opts.app = rest[++i];
    else if (a.startsWith('--app=')) opts.app = a.slice(6);
    else if (a === '--timeout') opts.timeout = parseInt(rest[++i], 10) || undefined;
    else if (a.startsWith('--timeout=')) opts.timeout = parseInt(a.slice(10), 10) || undefined;
    else if (a === '--screenshots') opts.screenshots = rest[++i];
    else if (a.startsWith('--screenshots=')) opts.screenshots = a.slice(14);
    else if (a === '--screenshots-mode') opts.screenshotsMode = rest[++i];
    else if (a.startsWith('--screenshots-mode=')) opts.screenshotsMode = a.slice(19);
    else if (a === '--out' || a === '-o') opts.out = rest[++i];
    else if (a.startsWith('--out=')) opts.out = a.slice(6);
    else if (a === '--content-id') opts.contentIds = splitList(rest[++i]);
    else if (a.startsWith('--content-id=')) opts.contentIds = splitList(a.slice(13));
    else if (a === '--media-type') opts.mediaType = rest[++i];
    else if (a.startsWith('--media-type=')) opts.mediaType = a.slice(13);
    else if (a === '--video') { const n = rest[i + 1]; opts.video = (n && !n.startsWith('-')) ? rest[++i] : 'mp4'; }
    else if (a.startsWith('--video=')) opts.video = a.slice(8);
    // inspect node-detail selector (targets one node so its fields/assertions can be shown)
    else if (a === '--id') opts.sel.id = rest[++i];
    else if (a.startsWith('--id=')) opts.sel.id = a.slice(5);
    else if (a === '--subtype') opts.sel.subtype = rest[++i];
    else if (a.startsWith('--subtype=')) opts.sel.subtype = a.slice(10);
    else if (a === '--text-contains' || a === '--textContains') opts.sel.textContains = rest[++i];
    else if (a.startsWith('--text-contains=')) opts.sel.textContains = a.slice(16);
    else if (a === '--text') opts.sel.text = rest[++i];
    else if (a.startsWith('--text=')) opts.sel.text = a.slice(7);
    else if (a === '--uri') opts.sel.uri = rest[++i];
    else if (a.startsWith('--uri=')) opts.sel.uri = a.slice(6);
    else if (a === '--index') opts.sel.index = parseInt(rest[++i], 10);
    else if (a.startsWith('--index=')) opts.sel.index = parseInt(a.slice(8), 10);
    else if (a === '--focused') opts.sel.focused = true;
    else if (a === '--assert') opts.assert = rest[++i];
    else if (a.startsWith('--assert=')) opts.assert = a.slice(9);
    else if (a === '--field') opts.field = rest[++i];
    else if (a.startsWith('--field=')) opts.field = a.slice(8);
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('-')) { /* ignore unknown flags */ }
    else opts.flows.push(a);
  }
  return opts;
}

const E2E_HELP = `
brighttest e2e — deterministic on-device UI tests (author-first, no AI in the loop)

  Drives a real Roku over ECP (launch, D-pad keypresses, text) and asserts on the live SceneGraph tree
  read via query/sgnodes. Flows are YAML files; selectors use a node's built-in id (dumped as name=),
  or text/subtype. The device must be in developer mode with ECP Network access = Permissive.

Usage:
  brighttest e2e run <flow…>        Run one or more *.e2e.yaml files (or a directory of them)
  brighttest e2e inspect            Dump a summary of the live tree (find ids/text/subtypes)
  brighttest e2e inspect --id <x>   Detail one node: every field + ready-to-paste assertions
  brighttest e2e record [-o <file>] Interactively drive the device and scaffold a flow file
  brighttest e2e stamp <src> -o <d> Copy a project, injecting ids onto un-annotated nodes (E2E build)

Node detail (inspect with a selector — targets a node you see on screen):
  --id <x> / --subtype <s> / --text <t> / --text-contains <t> / --uri <u> / --focused / --index <n>
                         Any combination narrows the match (AND). Prints all of the node's fields plus
                         suggested assertions built from its actual state.
  --assert <kind>        With --out, which assertion to append: visible (default) | text | focused | gone | field
  --field <name>         With --assert field, the field to capture (its current value becomes equals:)
  -o, --out <file>       Append the assertion to this flow file (created if missing)

Options:
  --host <ip[:pw][,…]>   Roku device IP(s) (or ROKU_HOST). Multiple → flows shard across devices in parallel.
                         Give a per-device password inline as ip:pw (else --password/ROKU_PASSWORD applies)
  --password <pw>        Roku dev password (or ROKU_PASSWORD) — enables screenshots; shared by hosts w/o ip:pw
  --app <id>            Channel to launch (default: dev; also the flow's appId)
  --content-id <a,b,…>   Deep-link matrix: run each flow once per contentId
  --media-type <t>       Media type paired with --content-id (e.g. movie, series)
  --timeout <sec>        Per-assertion wait timeout (default 10)
  --screenshots <dir>    Where to write screenshots (default: <stagingDir>/e2e/screenshots)
  --screenshots-mode <m> all (per-step, default) | failure (only on fail) | off
  --video [mp4|gif]      Assemble the per-step screenshots into a session video (needs ffmpeg on PATH)
  -o, --out <file>       (record) Write the scaffolded flow here (default: stdout)
  -h, --help             Show this help
`;

// `brighttest studio` — visual studio (web app) for authoring & debugging e2e flows on a device.
function parseStudioArgs(rest) {
  const o = { host: null, password: null, port: 8700, app: 'dev', flowsDir: null, open: false, help: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--host') o.host = rest[++i];
    else if (a.startsWith('--host=')) o.host = a.slice(7);
    else if (a === '--password' || a === '--pass') o.password = rest[++i];
    else if (a.startsWith('--password=')) o.password = a.slice(11);
    else if (a === '--port') o.port = parseInt(rest[++i], 10) || 8700;
    else if (a.startsWith('--port=')) o.port = parseInt(a.slice(7), 10) || 8700;
    else if (a === '--app') o.app = rest[++i];
    else if (a.startsWith('--app=')) o.app = a.slice(6);
    else if (a === '--flows-dir') o.flowsDir = rest[++i];
    else if (a.startsWith('--flows-dir=')) o.flowsDir = a.slice(12);
    else if (a === '--open' || a === '-o') o.open = true;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

const STUDIO_HELP = `
brighttest studio — visual studio for authoring & debugging e2e flows on a device

  Opens a local web app that mirrors a running Roku: inspect the live SceneGraph, drive the remote,
  author flows with autocomplete, run them with a step-by-step time-travel trace, and record sessions.
  Requires a Roku in developer mode with ECP Network access = Permissive.

Usage:
  brighttest studio --host <ip> [--password <pw>] [--port 8700] [--app dev] [--flows-dir flows] [--open]

Options:
  --host <ip>        Roku device IP (or ROKU_HOST)
  --password <pw>    Roku dev password (or ROKU_PASSWORD) — enables screenshots
  --port <n>         Local port for the studio (default 8700)
  --app <id>         Channel to launch / drive (default: dev)
  --flows-dir <dir>  Where flows are read and written (default: ./flows)
  -o, --open         Open the studio in your browser
  -h, --help         Show this help
`;

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

Skills (Agent Skills / agentskills.io format): writing-rooibos-tests, setting-up-brighttest, debugging-failing-tests, writing-e2e-flows.

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
  brighttest e2e run <flow…> --host <ip>             On-device UI e2e tests from YAML flows (see: e2e --help)
  brighttest studio --host <ip>                      Visual studio to author/debug flows on a device (see: studio --help)
  brighttest devices                                 Discover Rokus on the network and cache one's credentials

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
  if (argv[0] === 'e2e') {
    const eOpts = parseE2eArgs(argv.slice(1));
    if (eOpts.help) { console.log(E2E_HELP); process.exit(0); }
    if (!SCREENSHOT_MODES.includes(eOpts.screenshotsMode)) {
      console.error(`[brighttest e2e] --screenshots-mode must be one of: ${SCREENSHOT_MODES.join(', ')}`);
      process.exit(2);
    }
    if (eOpts.e2eAction === 'stamp') {
      const src = eOpts.flows[0];
      if (!src || !eOpts.out) { console.error('[brighttest e2e] stamp needs <srcDir> and --out <dir>'); process.exit(2); }
      const { stampProject } = require('../lib/e2e/stamp-ids');
      const { files, nodes } = stampProject(src, eOpts.out, {});
      console.log(`brighttest e2e stamp: injected ${nodes} id(s) across ${files} component(s) → ${eOpts.out}`);
      process.exit(0);
    }
    const cfg = loadConfig(process.cwd(), null);
    console.log('brighttest: e2e lane\n');
    const code = await require('../lib/e2e/run').run(cfg, eOpts);
    process.exit(code);
  }
  if (argv[0] === 'studio') {
    const o = parseStudioArgs(argv.slice(1));
    if (o.help) { console.log(STUDIO_HELP); process.exit(0); }
    const fs = require('fs'), path = require('path');
    if (!fs.existsSync(path.join(__dirname, '..', 'lib', 'studio', 'public', 'index.html'))) {
      console.error('[brighttest studio] the studio UI is not built yet. Run: npm run studio:build');
      process.exit(2);
    }
    // Resolve the device from flag → env / project .env → cache; start device-less if none (connect in the UI).
    const r = require('../lib/devices').resolveDevice({ host: o.host, password: o.password });
    await require('../lib/studio/server').start({ host: r.host, password: r.password, port: o.port, app: o.app, rootDir: process.cwd(), flowsDir: o.flowsDir });
    const url = `http://localhost:${o.port}`;
    const dev = r.host ? `device ${r.host}${r.source !== 'flag' ? ` (${r.source})` : ''}` : 'no device — discover one in the Devices tab';
    console.log(`brighttest studio → ${url}  ·  ${dev}`);
    if (o.open) {
      try {
        const { spawn } = require('child_process');
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
        const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
        spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
      } catch { /* ignore */ }
    }
    return; // keep the process alive — the server is listening
  }
  if (argv[0] === 'devices') {
    const d = require('../lib/devices');
    process.stdout.write('discovering Roku devices on the network…\n');
    const list = await d.discover({ timeoutMs: 4000 });
    if (!list.length) { console.log('  none found — make sure a Roku is powered on and on this LAN.'); process.exit(0); }
    list.forEach((dev, i) => console.log(`  ${i + 1}. ${dev.name}  ·  ${dev.model}  ·  ${dev.host}${dev.hasPassword ? '  (password cached)' : ''}`));
    if (!process.stdin.isTTY) process.exit(0);
    const dev = list[parseInt(await askLine(`\nselect a device to save [1-${list.length}] (Enter to skip): `), 10) - 1];
    if (!dev) process.exit(0);
    let pw = d.cachedPassword(dev.host);
    if (!pw) pw = await askLine(`dev password for ${dev.name} (${dev.host}): `, true);
    try {
      const info = await require('../lib/e2e/ecp').createDevice({ host: dev.host, password: pw }).deviceInfo();
      d.rememberDevice(dev.host, pw, info.model);
      console.log(`\nsaved ${dev.name} (${dev.host}) — commands now default to it (no --host needed).`);
      process.exit(0);
    } catch (e) { console.error(`\ncould not reach ${dev.host}: ${e.message}`); process.exit(1); }
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

// Only run the CLI when executed directly (not when required by tests).
if (require.main === module) main();

module.exports = { parseArgs, parseSkillsArgs, parseInitArgs, parseE2eArgs, parseStudioArgs, SKILLS_ACTIONS, E2E_ACTIONS, SCREENSHOT_MODES };
