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
    if (a === '--device=any') { opts.device = true; opts.devicePool = true; }
    else if (a === '--device' || a === '-d') {
      opts.device = true;
      // `--device any`: take the first free device of deviceLease.pool (an explicit --host still wins).
      if (argv[i + 1] === 'any') { opts.devicePool = true; i++; }
    }
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
    else if (a === '--idle-timeout') opts.idleTimeout = argv[++i];
    else if (a.startsWith('--idle-timeout=')) opts.idleTimeout = a.slice(15);
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--version' || a === '-v') opts.version = true;
    else if (a.startsWith('--host=')) opts.host = a.slice(7);
    else if (a.startsWith('--password=')) opts.password = a.slice(11);
    else if (a.startsWith('--junit=')) opts.junit = a.slice(8);
    else if (a.startsWith('--lcov=')) opts.lcov = a.slice(7);
    // device lease (device and cross-check lanes)
    else if (a === '--wait') opts.wait = argv[++i];
    else if (a.startsWith('--wait=')) opts.wait = a.slice(7);
    else if (a === '--as') opts.as = argv[++i];
    else if (a.startsWith('--as=')) opts.as = a.slice(5);
    else if (a === '--purpose') opts.purpose = argv[++i];
    else if (a.startsWith('--purpose=')) opts.purpose = a.slice(10);
    else if (a === '--no-lease') opts.noLease = true;
    // headless network fixtures (instrument.net): --net-record [file] records passthrough traffic to a HAR
    else if (a === '--net-record') { const n = argv[i + 1]; opts.netRecord = (n && !n.startsWith('-')) ? argv[++i] : true; }
    else if (a.startsWith('--net-record=')) opts.netRecord = a.slice(13);
    else if (a === '--net-unmatched') opts.netUnmatched = argv[++i];
    else if (a.startsWith('--net-unmatched=')) opts.netUnmatched = a.slice(16);
    else if (a === '--instrument') opts.instrument = true;
    else if (a.startsWith('--instrument=')) opts.instrumentValue = a.slice(13);
  }
  return opts;
}

// `brighttest doctor [--host <ip>] [--ecp-port <n>] [--json] [--show-serial]`: read-only device check.
const DOCTOR_HELP = `
brighttest doctor — check a Roku's capabilities and print the exact fix for anything wrong

Usage: brighttest doctor [--host <ip>] [--ecp-port <n>] [--json] [--show-serial]
       brighttest doctor --engines [--json]

  --engines  Run the engine-caps probe with the resolved brs-node and print the capability table, the engine
             flavor and the probe result. BRS-02 (Label.forceUpperCase) is shown as NON-DEVICE. Exit 1 when the
             probe fails or disagrees with the package metadata. No device is contacted.

  Reads the device-info only (no password, no lease, no keypresses), except with BRIGHTTEST_DOCTOR_HUB_PROBE=1:
  that opt-in hub probe needs ROKU_PASSWORD, takes the lease and replaces the dev channel. Exit 0 when every check passes,
  1 when one fails or the device is unreachable, 2 on a usage error. The serial is hidden unless --show-serial.
`;
function parseDoctorArgs(rest) {
  const o = { host: null, ecpPort: null, json: false, showSerial: false, engines: false, help: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--host') o.host = rest[++i];
    else if (a.startsWith('--host=')) o.host = a.slice(7);
    else if (a === '--ecp-port') o.ecpPort = rest[++i];
    else if (a.startsWith('--ecp-port=')) o.ecpPort = a.slice(11);
    else if (a === '--json') o.json = true;
    else if (a === '--show-serial') o.showSerial = true;
    else if (a === '--engines') o.engines = true;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

// `brighttest setup`: find or take a Roku host, check it, and save it as ROKU_HOST in the project .env.
const SETUP_HELP = `
brighttest setup — make a Roku the project's default device (ROKU_HOST in .env)

Usage: brighttest setup [--host <ip>] [--write | --print] [--shell bash|zsh|fish|sh|powershell|cmd|all]
                        [--env-file <path>] [--ecp-port <n>] [--force] [--json]

  Without --host it discovers Rokus on the network. It checks the device like doctor (device-info only: no lease,
  no password, no keypress), then asks before writing ROKU_HOST=<ip> to ./.env and adds .env to .gitignore.
  --write saves without asking (for agents); --print never writes; with no terminal it writes only with --write.
  It prints the export line for your shell and never edits a shell profile. The dev password is never asked for,
  stored or printed: set ROKU_PASSWORD, or run brighttest devices to cache it. --force writes even when a check fails.
  Exit 0 done, 1 the device check failed (nothing written), 2 usage or no host chosen.
`;
function parseSetupArgs(rest) {
  const o = { host: null, write: false, print: false, shell: null, envFile: null, ecpPort: null, force: false, json: false, help: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const val = (n) => (a === n ? rest[++i] : a.slice(n.length + 1));
    if (a === '--host' || a.startsWith('--host=')) o.host = val('--host');
    else if (a === '--shell' || a.startsWith('--shell=')) o.shell = val('--shell');
    else if (a === '--env-file' || a.startsWith('--env-file=')) o.envFile = val('--env-file');
    else if (a === '--ecp-port' || a.startsWith('--ecp-port=')) o.ecpPort = val('--ecp-port');
    else if (a === '--write') o.write = true;
    else if (a === '--print') o.print = true;
    else if (a === '--force') o.force = true;
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

// `brighttest mcp`: stdio MCP server (brighttest-mcp/v1) exposing the e2e primitives to agents.
// Tool names come from the real registry (the same list `tools/list` returns), so help cannot drift.
function mcpToolNames() { return require('../lib/mcp/tools').TOOLS.map((t) => t.name).join(', '); }
const mcpHelp = () => `
brighttest mcp — serve brighttest's deterministic e2e primitives to an AI agent over MCP (stdio)

Usage: brighttest mcp

  Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout (logs go to stderr). Tools (contract brighttest-mcp/v1):
  ${mcpToolNames()}
  (net_requests and net_mock open a net window, see https://ramon-lobo.github.io/brighttest/guide/mcp).

  The device comes only from the usual resolution chain (ROKU_HOST, ROKU_PASSWORD, project .env, device cache);
  no tool takes a host, a password or an absolute path. Outside a net window each device tool call takes the device
  lease for that call only and releases it when the call ends (busy: DEVICE_BUSY at once). The first net_requests or
  net_mock call opens a net window: one lease held for the session, which the other device tools reuse, released after
  up to 10 minutes without a device call, at the session lease cap (deviceLease.sessionMax, default 45 minutes), on lease loss or at session end. Per-session caps apply to
  presses and flow runs.
  Exit codes: 0 on a clean end of input, 1 on an internal error, 2 on a usage error.
`;

// `brighttest net convert <file.har> [-o <rules.json>]` — HAR to hand-editable rules (NET-N-T7).
const NET_HELP = `brighttest net convert <file.har> [-o <rules.json>]
  Turn a recorded HAR into a rules file (one rule per entry, ids har-1..n). Prints to stdout without -o.
  Redacted values stay redacted. Exits 1 for an unreadable or non-HAR input.

brighttest net token --ensure
  Keep the hub token per package: reuse the token stored (0600, under .brighttest/hub-tokens/) for the latest
  \`instrument build --net\`, or generate and store one. Prints the file path, the package hash prefix and
  created or reused; never the token. Export it with: export BRIGHTTEST_HUB_TOKEN="$(node -p "require('<file>').token")"`;
function parseNetArgs(argv) {
  const o = { action: null, file: null, out: null, help: false, ensure: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--ensure') o.ensure = true;
    else if (a === '-o' || a === '--out') o.out = argv[++i];
    else if (a.startsWith('--out=')) o.out = a.slice(6);
    else if (!o.action) o.action = a;
    else if (!o.file) o.file = a;
  }
  return o;
}

// `brighttest skills [install|update|export|list|uninstall] …` — a positional subcommand with its own parser.
const SKILLS_ACTIONS = ['install', 'update', 'export', 'list', 'uninstall'];
function parseSkillsArgs(rest) {
  const opts = { skillsAction: 'install', agent: null, skill: null, out: null, ref: null, skillsDir: null, force: false, noSafety: false, noAgents: false, withHook: false, withMcp: false, check: false, help: false };
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
    else if (a === '--check') opts.check = true;
    else if (a === '--no-safety') opts.noSafety = true;
    else if (a === '--no-agents') opts.noAgents = true;
    else if (a === '--with-hook') opts.withHook = true;
    else if (a === '--with-mcp') opts.withMcp = true;
    else if (a === '--force' || a === '-f') opts.force = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

// `brighttest instrument build [--out <zip>] [--strict|--no-strict] [--verbose] [--config <path>]`
const INSTRUMENT_ACTIONS = ['build', 'verify', 'census'];
function parseInstrumentArgs(rest) {
  const o = { instrumentAction: null, out: null, strict: null, failOnBsc: false, verbose: false, config: null, sideload: false, reuse: false, net: false, from: null, host: null, wait: null, max: null, expect: null, as: null, purpose: null, json: false, target: null, help: false, unknown: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (i === 0 && !a.startsWith('-')) { o.instrumentAction = a; continue; }
    if (!a.startsWith('-') && o.target === null && (o.instrumentAction === 'verify')) { o.target = a; continue; }
    if (a === '--json') o.json = true;
    else if (a === '--out' || a === '-o') o.out = rest[++i];
    else if (a.startsWith('--out=')) o.out = a.slice(6);
    else if (a === '--strict') o.strict = true;
    else if (a === '--no-strict') o.strict = false;
    else if (a === '--fail-on-bsc-errors') o.failOnBsc = true;
    else if (a === '--verbose') o.verbose = true;
    else if (a === '--config' || a === '-c') { o.config = rest[++i]; if (o.config === undefined) o.unknown.push(`${a} (needs a value)`); }
    else if (a.startsWith('--config=')) o.config = a.slice(9);
    else if (a === '--sideload') o.sideload = true;
    else if (a === '--reuse') o.reuse = true;
    else if (a === '--net') o.net = true;
    else if (a === '--from') { o.from = rest[++i]; if (o.from === undefined) o.unknown.push('--from (needs a value)'); }
    else if (a.startsWith('--from=')) o.from = a.slice(7);
    else if (a === '--host') o.host = rest[++i];
    else if (a.startsWith('--host=')) o.host = a.slice(7);
    else if (a === '--wait') o.wait = rest[++i];
    else if (a === '--max') o.max = rest[++i];
    else if (a === '--expect') o.expect = rest[++i];
    else if (a === '--as') o.as = rest[++i];
    else if (a === '--purpose') o.purpose = rest[++i];
    else if (a === '--help' || a === '-h') o.help = true;
    else o.unknown.push(a);
  }
  return o;
}

// Options for studio's start(): the raw parsed flags, never a host resolved here (the server decides the device).
function studioStartOptions(o, extra) {
  return { host: o.host, password: o.password, app: o.app, flowsDir: o.flowsDir, simulator: o.simulator === true, ...(o.as ? { leaseOpts: { acquireOpts: { agent: o.as } } } : {}), ...extra };
}

// Studio start failure -> exit code: usage mistakes and a missing UI bundle are 2, everything else 1.
function studioExitCode(e) {
  return e && (e.code === 'USAGE' || e.code === 'UI_NOT_BUILT') ? 2 : 1;
}

// Banner target: the simulator engine (name@version, flavor) or the device.
function studioTargetLabel(o, sim, resolveDevice) {
  if (sim && typeof sim.info === 'function') {
    const e = sim.info().engine || {};
    return `simulator ${e.name}@${e.version} (${e.flavor})`;
  }
  const r = o.host ? { host: o.host, source: 'flag' } : resolveDevice({});
  return r.host ? `device ${r.host}${r.source !== 'flag' ? ` (${r.source})` : ''}` : 'no device — discover one in the Devices tab';
}

const INSTRUMENT_HELP = `
brighttest instrument — build an instrumented (debug-only) package of your app

  Builds the app through brighterscript with the brighttest instrument plugin into a package you can sideload for
  debugging. Your source tree is never modified: everything is written to a staged copy. NEVER ship this package:
  it carries the instrumentation runtime and a per-build token (the release gate \`instrument verify\` finds it).

Usage:
  brighttest instrument build [--out <zip>] [--strict | --no-strict] [--from <dir|zip>] [--fail-on-bsc-errors] [--net] [--sideload [--reuse]] [--verbose] [--config <path>]
  brighttest instrument verify <zip|dir>                      Release gate: exit 3 if instrumentation markers are found, 0 if clean
  brighttest instrument census [--json] [--out <dir>] [--config <path>]
                                                              Static census of the app in the current directory (no device)

Options:
  -o, --out <zip>    Where the package goes (default: <stagingDir>/instrument/app.bt-instrumented.zip). It is written
                     only after every check passed; a failed build leaves nothing new at --out and keeps an older file.
  --from <dir|zip>   Instrument an already-built package instead of the source tree (for apps with their own build step:
                     run it first). A directory needs manifest plus source/ or components/ at its top; a zip is unpacked
                     to a temp dir (no .. or absolute paths, size caps). The input is never written to.
  --net              Bake the hub token from BRIGHTTEST_HUB_TOKEN (32 hex) so the e2e run's hub accepts this build;
                     fails (exit 1) when it is unset or malformed. The run reads the same variable.
  --strict           Fail (exit 4) when something could not be instrumented, even though the build is valid.
  --no-strict        Turn strict off (overrides brighttest.json). Default: "instrument": { "strict": false }.
  --fail-on-bsc-errors  Fail on every brighterscript error. By default only plugin errors (BT9xxx), BT9003 and parse errors
                     in files the plugin may rewrite fail the build; other bsc validation errors (1104, 1140, 1067, ...) are
                     compiler checks, not Roku runtime errors, so they print as warnings with a per-code histogram and a
                     ready-to-paste \`"diagnosticFilters": [...]\` line. \`diagnosticFilters\` (brighttest.json, array of
                     bsc codes) silences those codes and also applies to the headless lanes.
  --verbose          List every informational entry and every bsc warning of the report.
  --sideload         After a successful build, install the package on the device under the device lease
                     (needs --host; the dev password comes from ROKU_PASSWORD). Retries once after Delete.
  --reuse            With --sideload: skip the rebuild and install the newest stored build when the source fingerprint,
                     flags and hub token are unchanged; rebuild only after your own code changes. Not with --from.
  --host <ip>        Device for --sideload (required with it; never guessed from the cache).
  --wait/--max/--expect <dur>, --as <name>, --purpose <text>   Device lease options (see: device --help).
  -c, --config <p>   Path to brighttest.json (default: ./brighttest.json).
  -h, --help         Show this help.

Package contents: everything under rootDir the Roku packager would ship (images, fonts, root files), minus dotfiles,
node_modules, tests and tool config; set "instrument": { "files": [globs] } to choose another set (sourceGlobs only
selects the headless lanes' compile set). After a build, files under rootDir that are not in the package and pkg:/ paths
in the code that point at missing files are listed as warnings. "instrument.exclude" files are not rewritten but are
still packaged (and still compiled by bsc).

Plugin order: the instrument plugin runs after the Rooibos coverage plugin; this command builds the app only (no Rooibos).
One build = one fresh Program and plugin (no watch support).

Exit codes: 0 ok, 1 build failure (bsc or plugin error, BT9003 staged-output-invalid), 2 usage,
4 strict-mode failure (a could-not-instrument entry with strict on). Exit 3 belongs to \`instrument verify\`.
With --sideload: 1 also covers auth, TCP-80 and installer failures; 75/77/78 are device-lease codes.

stderr on failure: one line per blocking item (with --fail-on-bsc-errors, every bsc error), \`BT9003 staged-output-invalid <file>:<line> (...)\` or
\`strict: <kind> <file>:<line> <reason>\`, then \`instrument build failed: N error(s), no package written\`.
`;

// `brighttest e2e [run|inspect] <flow…> [options]` — the on-device UI test lane.
const E2E_ACTIONS = ['run', 'inspect', 'record', 'stamp', 'lint'];
const SCREENSHOT_MODES = ['all', 'failure', 'off'];
function parseE2eArgs(rest) {
  const opts = {
    e2eAction: 'run', flows: [], host: null, password: null, ecpPort: null, app: null,
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
    else if (a === '--ecp-port') opts.ecpPort = rest[++i];
    else if (a.startsWith('--ecp-port=')) opts.ecpPort = a.slice(11);
    else if (a === '--password' || a === '--pass') opts.password = rest[++i];
    else if (a.startsWith('--password=')) opts.password = a.slice(11);
    else if (a === '--app') opts.app = rest[++i];
    else if (a.startsWith('--app=')) opts.app = a.slice(6);
    else if (a === '--timeout') opts.timeout = parseInt(rest[++i], 10) || undefined;
    else if (a.startsWith('--timeout=')) opts.timeout = parseInt(a.slice(10), 10) || undefined;
    else if (a === '--screenshots') opts.screenshots = rest[++i];
    else if (a.startsWith('--screenshots=')) opts.screenshots = a.slice(14);
    else if (a === '--reset-device') opts.resetDevice = true;
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
    // device lease
    else if (a === '--wait') opts.wait = rest[++i];
    else if (a.startsWith('--wait=')) opts.wait = a.slice(7);
    else if (a === '--max') opts.max = rest[++i];
    else if (a.startsWith('--max=')) opts.max = a.slice(6);
    else if (a === '--expect') opts.expect = rest[++i];
    else if (a.startsWith('--expect=')) opts.expect = a.slice(9);
    else if (a === '--as') opts.as = rest[++i];
    else if (a.startsWith('--as=')) opts.as = a.slice(5);
    else if (a === '--purpose') opts.purpose = rest[++i];
    else if (a.startsWith('--purpose=')) opts.purpose = a.slice(10);
    else if (a === '--no-lease') opts.noLease = true;
    else if (a === '--no-hygiene') opts.noHygiene = true;
    else if (a === '--fail-on-skip') opts.failOnSkip = true;
    else if (a === '--junit') opts.junit = rest[++i];
    else if (a.startsWith('--junit=')) opts.junit = a.slice(8);
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('-')) {
      console.error(`[brighttest e2e] unknown option ${a.split('=')[0]} for e2e ${opts.e2eAction}; ignored`);
      // Space form (`--unknown value flow`): the value is not a flow path. Skip the next token unless it
      // looks like a flow (a *.yaml/*.yml file or an existing directory) so `--unknown flow.e2e.yaml` still works.
      const n = rest[i + 1];
      if (!a.includes('=') && n !== undefined && !n.startsWith('-') && !/\.ya?ml$/i.test(n)
        && !(require('fs').existsSync(n) && require('fs').statSync(n).isDirectory())) i++;
    }
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
  brighttest e2e lint <flow…>       Warn about selectors that cannot match (e.g. subtype: Group)
  brighttest e2e stamp <src> -o <d> Copy a project, injecting ids onto un-annotated nodes (E2E build)

Node detail (inspect with a selector — targets a node you see on screen):
  --id <x> / --subtype <s> / --text <t> / --text-contains <t> / --uri <u> / --focused / --index <n>
                         Any combination narrows the match (AND). Prints all of the node's fields plus
                         suggested assertions built from its actual state.
  --assert <kind>        With --out, which assertion to append: visible (default) | text | focused | gone | field
  --field <name>         With --assert field, the field to capture (its current value becomes equals:)
  -o, --out <file>       Append the assertion to this flow file (created if missing)

Options:
  --host <ip[:pw][,…]>   Roku device IP(s) (or ROKU_HOST in the shell or project .env, or the one cached device). Multiple → flows shard across devices in parallel.
                         Give a per-device password inline as ip:pw (else --password/ROKU_PASSWORD applies)
  --ecp-port <n>         ECP port on the device (or ROKU_ECP_PORT; default 8060) — for stubs/fakes; --host keeps ip[:pw]
  --password <pw>        Roku dev password (or ROKU_PASSWORD) — enables screenshots; shared by hosts w/o ip:pw
  --app <id>            Channel to launch (default: dev; also the flow's appId)
  --content-id <a,b,…>   Deep-link matrix: run each flow once per contentId
  --media-type <t>       Media type paired with --content-id (e.g. movie, series)
  --timeout <sec>        Per-assertion wait timeout (default 10)
  --screenshots <dir>    Where to write screenshots (default: <stagingDir>/e2e/screenshots)
  --reset-device         Before the run, per host: installer Delete, Home, then check the app launches off Home;
                         a host that never leaves Home twice in a row is dropped and the flows run on the rest
  --screenshots-mode <m> all (per-step, default) | failure (only on fail) | off
  --video [mp4|gif]      Assemble the per-step screenshots into a session video (needs ffmpeg on PATH)
  -o, --out <file>       (record) Write the scaffolded flow here (default: stdout)
  --wait <dur>           Device lease: how long to queue per device (default 30m; 0 = fail if busy → exit 75)
  --as <agent>           Device lease: holder label (or BRIGHTTEST_AGENT)
  --purpose <text>       Device lease: what this run is for (shown in \`brighttest device status\`)
  --no-hygiene           (run) Skip the Home ×2 press after taking the lease
  --fail-on-skip         (run) Exit 1 if any flow or step was skipped by requires: (default: skips do not fail the run)
  --junit <file>         (run) Write JUnit XML: one testsuite per flow file, one testcase per run; failures carry the
                         step and typed error code, skips carry the reason. Exit codes are unchanged
  --no-lease             Run without the device lease (warns and is audited; not for agents)
  -h, --help             Show this help
`;

// `brighttest device <action> [options] [-- <cmd…>]` — the cross-process device lease.
const DEVICE_ACTIONS = ['status', 'with', 'unlock', 'log', 'lock', 'renew', 'hook', 'reset', 'watch'];
function parseDeviceArgs(rest) {
  const o = {
    deviceAction: null, host: null, password: null, ecpPort: null, as: null, purpose: null, wait: null, max: null, idle: null,
    expect: null, keepalive: null, noHygiene: false, json: false, tail: null, force: false, reason: null, kill: false, lease: null,
    cmd: [], help: false, unknown: [], once: false, plain: false, all: false, noProbe: false, interval: null, for: null, tailRaw: null,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const val = (name) => (a === name ? rest[++i] : a.startsWith(name + '=') ? a.slice(name.length + 1) : undefined);
    let v;
    if (a === '--') { o.cmd = rest.slice(i + 1); break; }
    if (i === 0 && DEVICE_ACTIONS.includes(a)) { o.deviceAction = a; continue; }
    if (((a === '--device' || a === '-d') && rest[i + 1] === 'any') || a === '--device=any') { o.devicePool = true; if (a !== '--device=any') i++; continue; } // pool: with
    if ((v = val('--host')) !== undefined) o.host = v;
    else if ((v = val('--password')) !== undefined || (v = val('--pass')) !== undefined) o.password = v;
    else if ((v = val('--ecp-port')) !== undefined) o.ecpPort = v;
    else if ((v = val('--as')) !== undefined) o.as = v;
    else if ((v = val('--purpose')) !== undefined) o.purpose = v;
    else if ((v = val('--wait')) !== undefined) o.wait = v;
    else if ((v = val('--max')) !== undefined) o.max = v;
    else if ((v = val('--expect')) !== undefined) o.expect = v;
    else if ((v = val('--idle')) !== undefined) o.idle = v;
    else if (a === '--keepalive') o.keepalive = rest[i + 1] !== undefined && /^\d+$/.test(rest[i + 1]) ? rest[++i] : '';
    else if (a.startsWith('--keepalive=')) o.keepalive = a.slice(12);
    else if ((v = val('--tail')) !== undefined) { o.tail = parseInt(v, 10) || null; o.tailRaw = v; }
    else if ((v = val('--reason')) !== undefined) o.reason = v;
    else if ((v = val('--lease')) !== undefined) o.lease = v;
    else if (a === '--no-hygiene') o.noHygiene = true;
    else if ((v = val('--interval')) !== undefined) o.interval = v;
    else if (a === '--interval') o.interval = ''; // no value after it: cmdWatch rejects it
    else if ((v = val('--for')) !== undefined) o.for = v;
    else if (a === '--once') o.once = true;
    else if (a === '--plain') o.plain = true;
    else if (a === '--all') o.all = true;
    else if (a === '--no-probe') o.noProbe = true;
    else if (a === '--json') o.json = true;
    else if (a === '--force' || a === '-f') o.force = true;
    else if (a === '--kill') o.kill = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else o.unknown.push(a);
  }
  return o;
}

const DEVICE_HELP = `
brighttest device — share one Roku safely between processes, worktrees and agents (device lease)

  Every brighttest device lane (--device, --cross-check, e2e, studio) takes the lease itself. Use
  \`device with\` to wrap anything else that touches the device (curl, npx rooibos, scripts).

Usage:
  brighttest device status [--host <h>] [--json]           Who holds each device, since when, who waits
  brighttest device watch [--host <h>] [--once|--json|--plain] [--interval 2s] [--for <dur>] [--tail <n>] [--all] [--no-probe]
                                                           Live board of devices, queues and recent runs (read-only)
  brighttest device with [options] -- <cmd…>               Hold the lease while <cmd> runs (FIFO queue)
  brighttest device with --device any -- <cmd…>            Same, on the first free device of deviceLease.pool (--host wins)
  brighttest device lock [--host <h>] [options] [--json]  Take a session lease for multi-step debugging; prints the token
  brighttest device renew [--lease <token>]                Push a session's idle expiry forward (every use of the token does too)
  brighttest device unlock [--lease <token>]               Release your session (token from --lease or BRIGHTTEST_LEASE)
  brighttest device unlock --force --host <h> --reason "…" [--kill]   Human override (audited)
  brighttest device reset [--host <ip[:pw]>] [options]     Installer Delete, Home, wait for a Home screen (under the lease)
  brighttest device hook                                   Claude Code PreToolUse Bash guard (hook JSON on stdin)
  brighttest device log [--host <h>] [--tail <n>] [--json] The lease audit log (events.log)

Options (with):
  --host <ip[:pw]>     Device (or ROKU_HOST / cached device). The child gets ROKU_HOST, ROKU_PASSWORD and
                       BRIGHTTEST_LEASE, so nested brighttest commands re-use the lease.
  --as <agent>         Holder label (or BRIGHTTEST_AGENT), e.g. dev#2, device-qa#1, ci:run-123
  --purpose <text>     What you are doing (or BRIGHTTEST_PURPOSE); default: the command
  --wait <dur>         How long to queue (or BRIGHTTEST_LEASE_WAIT; default 30m). 0 = fail if busy
  --max <dur>          Hard cap on the hold (default 60m); the command is stopped at the cap (exit 77)
  --expect <dur>       Expected hold time, shown to waiters as an ETA
  --lease <token>      (with) Run under that session lease instead of queueing (same as BRIGHTTEST_LEASE=<token>)
  --idle <dur>         (lock) Session idle TTL, renewed by every use (default 10m)
  --max <dur>          (lock) Session hard cap (default 45m)
  --no-hygiene         Skip the Home ×2 reset after acquiring
  --keepalive[=sec]    (with) Send an ECP Fwd keypress every <sec> (default 240, min 60, 0 = off) while <cmd> runs
  --ecp-port <n>       ECP port (or ROKU_ECP_PORT) — local fakes only; part of the lease key when not 8060
Durations: 90s, 10m, 1h or milliseconds.

Exit codes: the command's own code · 75 busy / wait timed out · 77 lease lost, expired or not held ·
78 lease dir unusable (BRIGHTTEST_LEASE_DIR, default ~/.brighttest/leases) · 2 usage.
`;

// `brighttest studio` — visual studio (web app) for authoring & debugging e2e flows on a device.
function parseStudioArgs(rest) {
  const o = { host: null, password: null, port: null, app: 'dev', flowsDir: null, open: false, simulator: false, as: null, help: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--simulator') o.simulator = true;
    else if (a.startsWith('--simulator=')) o.badSimulator = a;
    else if (a === '--host') o.host = rest[++i];
    else if (a.startsWith('--host=')) o.host = a.slice(7);
    else if (a === '--password' || a === '--pass') o.password = rest[++i];
    else if (a.startsWith('--password=')) o.password = a.slice(11);
    else if (a === '--port') o.port = parseInt(rest[++i], 10) || null;
    else if (a.startsWith('--port=')) o.port = parseInt(a.slice(7), 10) || null;
    else if (a === '--app') o.app = rest[++i];
    else if (a.startsWith('--app=')) o.app = a.slice(6);
    else if (a === '--flows-dir') o.flowsDir = rest[++i];
    else if (a.startsWith('--flows-dir=')) o.flowsDir = a.slice(12);
    else if (a === '--as') o.as = rest[++i];
    else if (a.startsWith('--as=')) o.as = a.slice(5);
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
  brighttest studio --host <ip> [--port 8700] [--app dev] [--as <agent>] [--flows-dir flows] [--open]
  brighttest studio --simulator [--port 8700] [--flows-dir flows] [--open]

Options:
  --host <ip>        Roku device IP (or ROKU_HOST)
  --password <pw>    Roku dev password — discouraged (it shows in the process list); set ROKU_PASSWORD instead. Enables screenshots
  --port <n>         Local port for the studio (default 8700; if busy, the first free of 8701-8709)
  --app <id>         Channel to launch / drive (default: dev)
  --as <agent>       Device lease: holder label for this Studio (or BRIGHTTEST_AGENT), e.g. dev#2, qa:run-123
  --flows-dir <dir>  Where flows are read and written (default: ./flows)
  --simulator        Run against the local brs-node simulator instead of a device (state-only). Uses the stock
                     engine (npm i brs-node) unless engines.brsNode or BRIGHTTEST_ENGINES picks another one.
                     Takes no value; cannot be combined with --host or a device pool.
  -o, --open         Open the studio in your browser
  -h, --help         Show this help

Device lease:
  Studio holds the device lease only while you use it. It yields to a waiting session after 60 seconds
  idle and releases after 5 minutes idle; the lease record marks it interactive so waiters see that. A 423 response means another agent holds the device; use
  "Take over" in the Studio to override it explicitly.

Source checkouts:
  npm run studio:build   builds the Studio web bundle (not needed for the published package)
`;

// `brighttest init [--force]`
function parseInitArgs(rest) {
  const opts = { force: false, brownfield: false, greenfield: false, dryRun: false, help: false };
  for (const a of rest) {
    if (a === '--force' || a === '-f') opts.force = true;
    else if (a === '--brownfield') opts.brownfield = true;
    else if (a === '--greenfield') opts.greenfield = true;
    else if (a === '--dry-run') opts.dryRun = true;
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
  brighttest init --brownfield [--force] [--dry-run]
  brighttest init --greenfield [--force]

  --brownfield   For an existing app you will not edit: runs the instrument census, writes the "instrument" block
                 into brighttest.json (state.registrySections proposed from the registry sections the census finds),
                 adds .brighttest/, *.bt-instrumented.zip and brighttest.json.bak to .gitignore, and does not add an example spec or an
                 npm test script. An existing brighttest.json is merged, not overwritten: valid keys are kept, missing ones
                 added, wrong-typed ones fixed (each change is listed; a .bak is kept when it writes); a valid file is
                 left untouched. --force replaces the instrument block. --dry-run prints the plan and writes nothing.
  --greenfield   For an app built with brighttest in mind: also copies BTStore.brs and BTHttp.brs (version-headed) into
                 source/brighttest/ and adds BT_AGENT=false to bs_const in the manifest (existing consts kept). Scene/Task components include them with
                 <script type="text/brightscript" uri="pkg:/source/brighttest/BTStore.brs" />. With --greenfield, --force
                 refreshes only the two templates. Cannot be combined with --brownfield.
`;

const SKILLS_HELP = `
brighttest skills — install AI-agent skills for working with brighttest

  Ships skills (authoring rules, setup, debugging, flows, state, MCP, Studio)
  that teach AI coding agents how to use this project.

Usage:
  brighttest skills install   [--agent <a>] [--skill <name>] [--force]   Install into detected agents
  brighttest skills update    [--ref <branch|tag>] [--agent <a>] ...      Pull the latest skills from the repo
  brighttest skills export    [--out <dir>] [--force]                     Dump the raw skill folders
  brighttest skills list                                                  List available skills + detected agents
  brighttest skills uninstall [--agent <a>] [--skill <name>] [--force]    Remove installed skills (and the hook/MCP entries it merged)
  brighttest skills --check                                               CI: exit 1 if skills/manifest.json drifted

Options:
  --agent <a>       Target agent(s): claude, cursor, agents, copilot, windsurf, cline, zed, agentskills,
                    opencode, hermes, or all. Omit to auto-detect from the project.
  --skill <name>    Limit to one skill (default: all). e.g. writing-rooibos-tests
  --ref <ref>       (update) Git branch/tag to fetch from (default: main)
  --skills-dir <d>  (agentskills target) Skill folder root (default: .agents/skills)
  -o, --out <dir>   (export) Destination (default: ./brighttest-skills)
  --no-safety       (install, update) Skip the always-on safety block (default: written for every target)
  --no-agents       (install, update, uninstall) Skip subagent definitions (default: .claude/agents/<name>.md for claude; .github/agents/<name>.agent.md for definitions whose hosts include copilot)
  --with-hook       (install, claude target) Merge the device-lease guard hook into .claude/settings.json (never overwrites; invalid JSON is refused)
  --with-mcp        (install, claude target) Merge the brighttest MCP server into .mcp.json (never overwrites; invalid JSON is refused)
  --check           Compare skills/manifest.json with the skills/ tree (no writes); exit 1 on drift
  -f, --force       Overwrite files not created by brighttest
  -h, --help        Show this help

Skills (Agent Skills / agentskills.io format): adopting-brighttest, adopting-brighttest-brownfield, adopting-brighttest-greenfield, assessing-a-roku-app, debugging-failing-tests, instrumenting-a-roku-app, mapping-a-roku-app, mocking-network-and-store, setting-up-brighttest, testing-app-state, using-a-roku-device-safely,
  using-brighttest-mcp, using-brighttest-studio, wiring-brighttest-into-ci, writing-e2e-flows, writing-rooibos-tests.

Auto-detection (no --agent) writes to whichever the project already uses: .claude/ or CLAUDE.md, .cursor/,
.windsurf/, .clinerules, .rules (Zed), .agents/ (agentskills), AGENTS.md/opencode, .github/ (Copilot).
Every target also gets the always-on safety rules (device lease, secrets, claims): one managed block named
brighttest (safety + skill index) in CLAUDE.md, AGENTS.md, .rules or .github/copilot-instructions.md, or a
brighttest-safety rule file for Cursor, Windsurf and Cline. Content outside the block is preserved; old
per-skill blocks and flattened Cursor files are migrated (a full install also migrates those of retired skills). uninstall removes the block and the index.
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
  brighttest instrument build                        Build an instrumented debug package, never for release (see: instrument --help)
  brighttest builds list|show|add|install|…          The build history store; install --latest re-sideloads (see: builds --help)
  brighttest e2e run <flow…> --host <ip>             On-device UI e2e tests from YAML flows (see: e2e --help)
  brighttest studio --host <ip>                      Visual studio to author/debug flows on a device (see: studio --help)
  brighttest net convert <file.har> [-o <rules.json>]  Turn a recorded HAR into hand-editable net rules
  brighttest assess [<dir>] [--json] [--out <dir>]   Read-only assessment of a Roku project (see: assess --help)
  brighttest features graph [<dir>] [--out <dir>]    Map an app's files, components and calls into a graph (see: features --help)
  brighttest features check [<tree.json>]            Validate a feature tree against its graph; exit 3 when invalid (see: features --help)
  brighttest features render [<tree.json>] [--auto]  Write a self-contained HTML report of a feature tree (see: features --help)
  brighttest doctor --host <ip> [--json]             Check a device's capabilities and print exact fixes
  brighttest setup [--host <ip>] [--write]           Save a Roku as the project's default device (ROKU_HOST in .env)
  brighttest mcp                                     Serve e2e primitives to an AI agent over MCP stdio (see: mcp --help)
  brighttest devices                                 Discover Rokus on the network and cache one's credentials
  brighttest device status|with|unlock|log           Share a device safely: the device lease (see: device --help)

Options:
  -d, --device          Run on a Roku device (deploys + runs Rooibos, reports coverage)
      --device any      Run on the first free device of deviceLease.pool (FIFO across the pool; --host wins)
      --coverage        Headless coverage: runs the Rooibos runner on the brs-node simulator
                        (no device) and writes LCOV. Runs @SGNode node suites too.
      --no-sgnode       Skip @SGNode node suites and use the faster SceneGraph-off driver.
                        (Node suites otherwise run headless by default.)
      --timeout <sec>   Watchdog timeout (headless 300s, device 900s by default)
      --idle-timeout <sec>  Device idle watchdog: abort after this many seconds without device output
                        (default 120; 0 disables; config: deviceIdleTimeout; also passed to the Rooibos CLI)
      Engines: env BRIGHTTEST_ENGINES=auto|patched|stock|<package> (or "engines" in brighttest.json)
                        picks the brs-node/rooibos build; env wins over config. Default auto = patched.
                        A package of the other kind picks the same flavor of this kind.
      --host <ip>       Roku device IP (device mode)
      --password <pw>   Roku developer password (device mode)
      --lcov [path]     Write an LCOV report from the device run (device mode;
                        default path: coverage/lcov.info)
      --junit <path>    Write a JUnit XML report (headless mode)
      --net-record [file]       Headless: pass requests through to instrument.net.upstreamHosts and record a HAR
                                (default .brighttest/net/<run>.har)
      --net-unmatched <policy>  Headless: fail (599, default with fixtures) or passthrough for requests no rule matches
      --instrument              Headless: build with the instrument plugin (state agent; net too when configured) and
                                the run's hub; same as "instrument": {"enabled": true} for one run
      --wait <dur>      Device lease: how long to queue for the device (default 30m; 0 = fail if busy)
      --as <agent>      Device lease: holder label (or BRIGHTTEST_AGENT)
      --purpose <text>  Device lease: what this run is for (shown in \`brighttest device status\`)
      --no-lease        Run without the device lease (warns and is audited; not for agents)
  -c, --config <path>   Path to brighttest.json (default: ./brighttest.json)
  -v, --version         Print the version and exit
  -h, --help            Show this help

Config (brighttest.json, all optional):
  { "rootDir": ".", "sourceGlobs": ["manifest","source/**/*","components/**/*"],
    "testsFilePattern": "**/*.spec.bs", "stagingDir": ".brighttest" }
`;

async function main() {
  const argv = process.argv.slice(2);

  // `-v` / `--version` as the first token: print the version and exit (before subcommand dispatch).
  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log(require('../package.json').version);
    process.exit(0);
  }

  // Positional subcommands (init, skills). The flag-only lanes below are untouched.
  if (argv[0] === 'init') {
    const iOpts = parseInitArgs(argv.slice(1));
    if (iOpts.help) { console.log(INIT_HELP); process.exit(0); }
    if (iOpts.dryRun && !iOpts.brownfield) { process.stderr.write('[brighttest init] --dry-run is only supported with --brownfield\nUsage: brighttest init --brownfield [--force] [--dry-run]\n'); process.exit(2); }
    const code = await require('../lib/init').run(null, iOpts);
    process.exit(code);
  }
  if (argv[0] === 'skills') {
    const sOpts = parseSkillsArgs(argv.slice(1));
    if (sOpts.help) { console.log(SKILLS_HELP); process.exit(0); }
    const code = await require('../lib/skills').run(null, sOpts);
    process.exit(code);
  }
  if (argv[0] === 'instrument') {
    const o = parseInstrumentArgs(argv.slice(1));
    if (o.help) { console.log(INSTRUMENT_HELP); process.exit(0); }
    if (!INSTRUMENT_ACTIONS.includes(o.instrumentAction)) {
      console.error(`[brighttest instrument] ${o.instrumentAction ? `unknown action "${o.instrumentAction}"` : 'missing action'}; available: ${INSTRUMENT_ACTIONS.join(', ')} (see: instrument --help)`);
      process.exit(2);
    }
    if (o.unknown.length) { console.error(`[brighttest instrument] unknown option(s): ${o.unknown.join(' ')}`); process.exit(2); }
    if (o.instrumentAction === 'verify') {
      if (!o.target) { console.error('[brighttest instrument verify] needs a <zip|dir> to check'); process.exit(2); }
      let r;
      try { r = await require('../lib/instrument/verify').verify(o.target); } catch (e) { console.error(`[brighttest instrument verify] ${e.message}`); process.exit(2); }
      if (r.exitCode === 0) console.log(`instrument verify: clean (no instrumentation markers in ${o.target})`);
      else {
        console.error(`instrument verify: INSTRUMENTED: ${r.markers.length} marker(s) in ${o.target}; do not release this package`);
        for (const m of r.markers) console.error(`  ${m.kind}: ${m.path}${m.detail ? ` (${m.detail})` : ''}`);
      }
      process.exit(r.exitCode);
    }
    if (o.instrumentAction === 'census') {
      const censusMod = require('../lib/instrument/census');
      let c;
      try { c = await censusMod.census(process.cwd(), { config: o.config }); } catch (e) { console.error(`[brighttest instrument census] ${e.message}`); process.exit(2); }
      if (o.out) {
        const w = censusMod.write(c, require('path').resolve(o.out));
        console.error(`instrument census: wrote ${w.json} and ${w.md}`);
      }
      console.log(o.json ? JSON.stringify(c, null, 2) : censusMod.renderMarkdown(c));
      process.exit(0);
    }
    let target = null;
    if (o.sideload) {
      // Explicit host only (no cached-device guess); the password comes from ROKU_PASSWORD / the credential path.
      const { splitHost } = require('../lib/device-command');
      const inline = splitHost(o.host);
      if (!inline.host) { console.error('[brighttest instrument] --sideload needs --host <ip> (no cached-device guess)'); process.exit(2); }
      target = { host: inline.host, password: require('../lib/devices').resolveDevice({ host: inline.host, password: inline.password }).password };
    }
    const cfg = loadConfig(process.cwd(), o.config);
    if (o.reuse && o.from) { console.error('[brighttest instrument] --reuse cannot be combined with --from (no fingerprint of a prebuilt input); drop one of them'); process.exit(2); }
    if (o.reuse && !target) console.error('instrument build: --reuse only applies with --sideload; building as usual');
    if (o.reuse && target) {
      const rr = await require('../lib/instrument/build').tryReuse(cfg, { out: o.out, strict: o.strict, net: o.net, failOnBscErrors: o.failOnBsc }, { ...target, wait: o.wait, max: o.max, expect: o.expect, as: o.as, purpose: o.purpose || 'instrument build --reuse' });
      if (rr.reused) process.exit(rr.exitCode);
    }
    const r = await require('../lib/instrument/build').build(cfg, { out: o.out, strict: o.strict, verbose: o.verbose, net: o.net, from: o.from, failOnBscErrors: o.failOnBsc });
    if (r.exitCode !== 0 || !target) process.exit(r.exitCode);
    const code = await require('../lib/instrument/sideload').sideload(cfg, { zip: r.out, ...target, record: r.record ? { store: r.record.store, id: r.record.id, via: 'build' } : null, wait: o.wait, max: o.max, expect: o.expect, as: o.as, purpose: o.purpose });
    process.exit(code);
  }
  if (argv[0] === 'builds') {
    const code = await require('../lib/builds/cli').run(argv.slice(1));
    process.stdout.write('', () => process.exit(code));
    return;
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
    if (eOpts.e2eAction === 'lint') {
      if (!eOpts.flows.length) { console.error('[brighttest e2e] lint needs <flow…>'); process.exit(2); }
      process.exit(require('../lib/e2e/lint').lint(eOpts.flows, console.log, loadConfig(process.cwd(), null)));
    }
    const cfg = loadConfig(process.cwd(), null);
    console.log('brighttest: e2e lane\n');
    const code = await require('../lib/e2e/run').run(cfg, eOpts);
    process.exit(code);
  }
  if (argv[0] === 'studio') {
    const o = parseStudioArgs(argv.slice(1));
    if (o.help) { console.log(STUDIO_HELP); process.exit(0); }
    if (o.badSimulator) { console.error(`[brighttest studio] ${o.badSimulator}: --simulator is a flag and takes no value`); process.exit(2); }
    if (o.as !== null && !String(o.as || '').trim()) { console.error('[brighttest studio] --as needs an agent name, e.g. --as dev#2'); process.exit(2); }
    if (o.simulator && o.password) console.error('[brighttest studio] warning: --password is ignored with --simulator');
    if (o.simulator && o.host) { console.error('[brighttest studio] --simulator cannot be combined with --host'); process.exit(2); }
    // The raw --host/--password go to the server, which owns the device rules (explicit host wins, several cached
    // devices fail instead of guessing, none starts device-less). The CLI never resolves the host for studio.
    // Without --port, fall back to 8701-8709 when 8700 is taken (parallel worktrees each running a Studio).
    const fallback = o.port ? null : [8701, 8702, 8703, 8704, 8705, 8706, 8707, 8708, 8709];
    let server;
    try {
      server = await require('../lib/studio/server').start(studioStartOptions(o, { requireUi: true, port: o.port || 8700, portFallback: fallback, rootDir: process.cwd(), cfg: loadConfig(process.cwd(), null), simLog: (m) => console.error(m) }));
    } catch (e) {
      console.error(`[brighttest studio] ${e.message}`);
      process.exit(studioExitCode(e));
    }
    const port = server.address().port;
    if (!o.port && port !== 8700) console.log(`(port 8700 is in use; using ${port})`);
    const url = `http://localhost:${port}`;
    // Display only: the server already chose the target with its own rules.
    const dev = studioTargetLabel(o, server.sim, require('../lib/devices').resolveDevice);
    console.log(`brighttest studio → ${url}  ·  ${dev}`);
    if (server.hubNotice) { // what the hub will do once Studio holds the lease, and why not
      console.log(server.hubNotice.line);
      if (server.hubNotice.warn) console.error(`[brighttest studio] ${server.hubNotice.warn}`);
    }
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
  if (argv[0] === 'mcp') {
    if (argv.length > 1 && argv[1] !== '--help' && argv[1] !== '-h') { console.error('[brighttest mcp] takes no arguments (see: brighttest mcp --help)'); process.exit(2); }
    if (argv[1]) { console.log(mcpHelp()); process.exit(0); }
    process.exit(await require('../lib/mcp/server').run({ cwd: process.cwd() }));
  }
  if (argv[0] === 'net') {
    const n = parseNetArgs(argv.slice(1));
    if (n.action === 'token' && !n.help) {
      if (!n.ensure) { console.error('[brighttest net] token needs --ensure (see: brighttest net --help)'); process.exit(2); }
      let root = process.cwd();
      try { root = loadConfig(process.cwd(), null).rootDir || root; } catch { /* no config: the current directory */ }
      const { hubTokenFromEnv } = require('../lib/instrument/hub');
      const store = require('../lib/instrument/hub-token-store');
      try {
        if (hubTokenFromEnv(process.env)) { console.log('BRIGHTTEST_HUB_TOKEN is already set in this shell; nothing stored or changed'); process.exit(0); }
        const r = store.ensureToken(root);
        const rel = require('path').relative(root, r.file) || r.file;
        console.log(`${r.created ? 'created' : 'reused'} hub token: ${rel} (package ${store.shaPrefix(r.sha256)})`);
        console.log(`BRIGHTTEST_HUB_TOKEN is not set in this shell. Export it without printing it: export BRIGHTTEST_HUB_TOKEN="$(node -p "require('${r.file}').token")"`);
        process.exit(0);
      } catch (e) { console.error(`[brighttest net] ${e.message}`); process.exit(1); }
    }
    if (n.help || n.action !== 'convert') { console.log(NET_HELP); process.exit(n.help ? 0 : 2); }
    process.exit(require('../lib/instrument/net-convert').run(n));
  }
  if (argv[0] === 'device') {
    const o = parseDeviceArgs(argv.slice(1));
    if (o.help || !o.deviceAction) { console.log(DEVICE_HELP); process.exit(o.help ? 0 : 2); }
    if (o.deviceAction === 'hook') process.exit(await require('../lib/device-hook').main()); // PreToolUse guard: always exit 0
    const cfg = loadConfig(process.cwd(), null);
    if (o.deviceAction === 'reset') process.exit(await require('../lib/e2e/reset').cmdReset(o, cfg));
    const code = await require('../lib/device-command').run(o, cfg);
    // process.exit() drops pending async pipe writes (a piped `device log --json` was cut at 8192 bytes):
    // exit only once stdout has flushed. Streams through the pipe, no extra buffering.
    process.stdout.write('', () => process.exit(code));
    return;
  }
  if (argv[0] === 'assess') {
    const code = await require('../lib/assess').run(argv.slice(1));
    process.stdout.write('', () => process.exit(code));
    return;
  }
  if (argv[0] === 'features') {
    const code = await require('../lib/features').run(argv.slice(1));
    process.stdout.write('', () => process.exit(code));
    return;
  }
  if (argv[0] === 'issue') {
    const code = await require('../lib/issue').run(argv.slice(1));
    process.stdout.write('', () => process.exit(code));
    return;
  }
  if (argv[0] === 'doctor') {
    const o = parseDoctorArgs(argv.slice(1));
    if (o.help) { console.log(DOCTOR_HELP); process.exit(0); }
    if (o.engines) {
      let code;
      try { code = require('../lib/engine-caps').doctorEngines(loadConfig(process.cwd(), null), { json: o.json }); }
      catch (e) {
        if (e && e.name === 'EngineError') { console.error(`[brighttest] ${e.message}`); process.exit(2); }
        throw e;
      }
      process.exit(code);
    }
    const code = await require('../lib/doctor').run(o);
    process.exit(code);
  }
  if (argv[0] === 'setup') {
    const o = parseSetupArgs(argv.slice(1));
    if (o.help) { console.log(SETUP_HELP); process.exit(0); }
    const code = await require('../lib/setup').run(o, { ask: askLine });
    process.stdout.write('', () => process.exit(code));
    return;
  }
  if (argv[0] === 'devices') {
    const d = require('../lib/devices');
    process.stderr.write('(to see who is using a device, run: brighttest device status)\n');
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
  if (opts.version) { console.log(require('../package.json').version); process.exit(0); }
  if (opts.help) { console.log(HELP); process.exit(0); }

  if (opts.idleTimeout !== undefined) {
    try { opts.idleTimeout = require('../lib/config').parseIdleTimeout(opts.idleTimeout, '--idle-timeout'); }
    catch (e) { console.error(`[brighttest] ${e.message}`); process.exit(2); }
  }
  const cfg = loadConfig(process.cwd(), opts.config);
  if ((opts.netRecord || opts.netUnmatched !== undefined) && (opts.device || opts.crossCheck)) {
    console.error('[brighttest] --net-record / --net-unmatched apply to the headless lanes only (not --device or --cross-check).');
    process.exit(2);
  }
  if (opts.netUnmatched !== undefined && opts.netUnmatched !== 'fail' && opts.netUnmatched !== 'passthrough') {
    console.error('[brighttest] --net-unmatched must be "fail" or "passthrough".');
    process.exit(2);
  }
  if (opts.instrumentValue !== undefined) {
    console.error('[brighttest] --instrument takes no value (use --instrument alone)');
    process.exit(2);
  }
  if (opts.instrument && (opts.device || opts.crossCheck)) {
    console.error('[brighttest] --instrument applies to the headless lanes only (for a device build use: brighttest instrument build --sideload)');
    process.exit(2);
  }
  let lane, label;
  if (opts.crossCheck) { lane = require('../lib/cross-check'); label = 'cross-check (headless vs device)'; }
  else if (opts.device) { lane = require('../lib/device'); label = 'device (coverage)'; }
  else if (opts.coverage) { lane = require('../lib/coverage-headless'); label = 'headless coverage'; }
  else { lane = require('../lib/headless'); label = 'headless'; }
  console.log(`brighttest: ${label} lane\n`);
  let code;
  try {
    if (!opts.device) require('../lib/engine-caps').warnNonDeviceUse(cfg); // BRS-02 is non-device: say so on stderr
    code = await lane.run(cfg, opts);
  } catch (e) {
    if (e && e.name === 'EngineError') { console.error(`[brighttest] ${e.message}`); process.exit(2); }
    throw e;
  }
  process.exit(code);
}

// Only run the CLI when executed directly (not when required by tests).
if (require.main === module) {
  // A reader that closes early (`brighttest skills list | head`) is not an error: exit quietly with status 0.
  // Any other stdout write error stays visible (rethrown as uncaught).
  process.stdout.on('error', (e) => { if (e && e.code === 'EPIPE') process.exit(0); throw e; });
  main();
}

module.exports = { parseNetArgs, studioStartOptions, parseArgs, parseInstrumentArgs, INSTRUMENT_ACTIONS, parseSkillsArgs, parseInitArgs, parseE2eArgs, parseStudioArgs, studioExitCode, studioTargetLabel, parseDeviceArgs, parseDoctorArgs, parseSetupArgs, SKILLS_ACTIONS, E2E_ACTIONS, DEVICE_ACTIONS, SCREENSHOT_MODES };
