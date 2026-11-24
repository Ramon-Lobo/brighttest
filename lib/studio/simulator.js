'use strict';
// Simulator target: builds the app instrumented, runs it in a brs-node CLI child (zip mode) and exposes a loopback
// headless hub the State inspector can use as `opts.net`. No device, no lease, no LAN. The child is preloaded with
// sim-watchdog.js so it exits when this process dies (IPC channel closes), and is killed on stop, SIGINT, SIGTERM and exit.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const engines = require('../engines');

const WATCHDOG = path.join(__dirname, 'sim-watchdog.js');
const SETTLE_MS = 1500;
const HELLO_TIMEOUT_MS = 30000;
const POLL_MS = 200;
const KILL_GRACE_MS = 2000;
const TAIL_LINES = 200;
const PATCHED_HINT = 'patched brs-node is known to hang on Tasks (no agent.hello); set engines.brsNode: stock';

class SimulatorError extends Error {
  constructor(message, code, extra) { super(message); this.name = 'SimulatorError'; this.code = code; if (extra) Object.assign(this, extra); }
}

function statePaths(cfg) {
  const r = cfg && cfg.instrument && cfg.instrument.state && cfg.instrument.state.redact;
  return r && Array.isArray(r.paths) ? r.paths.filter((v) => typeof v === 'string') : [];
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
}
function commandOfPid(pid) {
  try { return childProcess.execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

// A bounded ring of the child's last output lines.
function createTail(max = TAIL_LINES) {
  const lines = [];
  let partial = '';
  return {
    push(chunk) {
      const parts = (partial + String(chunk)).split(/\r?\n/);
      partial = parts.pop();
      for (const l of parts) { lines.push(l); if (lines.length > max) lines.shift(); }
    },
    lines() { return partial ? lines.concat(partial) : lines.slice(); },
  };
}

// Engine for the simulator: an explicit config/env choice wins; otherwise stock (patched 2.2.0 hangs on Tasks).
function pickEngine(cfg, seam) {
  const resolve = seam.resolveEngine || engines.resolveEngine;
  const m = engines.engineMode('brsNode', { cfg, env: seam.env });
  const eng = resolve('brsNode', m.source === 'default' ? 'stock' : m.mode);
  return { eng, source: m.source };
}

// Reap a child left by a previous run (its main loop ignored the watchdog after a kill -9 of the parent).
function reapStale(pidFile, seam, log) {
  let raw;
  try { raw = fs.readFileSync(pidFile, 'utf8'); } catch { return false; }
  const pid = parseInt(raw, 10);
  let reaped = false;
  const isAlive = seam.isAlive || pidAlive;
  const commandOf = seam.commandOf || commandOfPid;
  if (pid > 0 && process.platform !== 'win32' && isAlive(pid) && /brs\.cli\.js/.test(commandOf(pid) || '')) {
    try { (seam.kill || process.kill)(pid, 'SIGKILL'); reaped = true; log(`[brighttest simulator] reaped a stale engine child (pid ${pid})`); } catch { /* gone */ }
  }
  try { fs.unlinkSync(pidFile); } catch { /* none */ }
  return reaped;
}

async function startSimulator({ cfg, rootDir, log = () => {}, seam = {} } = {}) {
  const now = seam.now || Date.now;
  const settleMs = seam.settleMs !== undefined ? seam.settleMs : SETTLE_MS;
  const helloTimeoutMs = seam.helloTimeoutMs !== undefined ? seam.helloTimeoutMs : HELLO_TIMEOUT_MS;
  const pollMs = seam.pollMs !== undefined ? seam.pollMs : POLL_MS;
  const killGraceMs = seam.killGraceMs !== undefined ? seam.killGraceMs : KILL_GRACE_MS;
  const hubStart = seam.startHub || require('../instrument/hub').startHub;
  const localLease = seam.localLease || require('../instrument/hub').localLease;
  const buildApp = seam.build || require('../instrument/build').build;
  const spawn = seam.spawn || childProcess.spawn;

  // 1. engine
  const { eng, source } = pickEngine(cfg, seam);
  if (eng.flavor === 'patched' && source !== 'default') log(`[brighttest simulator] warning: ${PATCHED_HINT}`);
  const cli = engines.binOf(eng);

  const stagingDir = (cfg && cfg.stagingDir) || path.resolve(rootDir || process.cwd(), '.brighttest');
  const simDir = path.join(stagingDir, 'simulator');
  const pidFile = path.join(simDir, 'child.pid');
  const zip = path.join(simDir, 'app.zip');
  fs.mkdirSync(simDir, { recursive: true });

  // 2. stale child
  reapStale(pidFile, seam, log);

  // 3. hub
  const token = crypto.randomBytes(16).toString('hex');
  const redactPaths = statePaths(cfg);
  const hub = await hubStart({ mode: 'headless', host: '127.0.0.1', port: 0, lease: localLease(), tokens: [token], buildToken: token, redactPaths });

  // 4. build
  let built;
  try {
    built = await buildApp(cfg, { out: zip, hub: { host: '127.0.0.1', port: hub.port }, token, log });
  } catch (e) {
    try { await hub.stop(); } catch { /* best-effort */ }
    throw e;
  }
  if (!built || built.exitCode !== 0 || !built.out) {
    try { await hub.stop(); } catch { /* best-effort */ }
    const lines = (built && built.lines) || [];
    throw new SimulatorError(`simulator build failed${lines.length ? `:\n${lines.join('\n')}` : ''}`, 'SIM_BUILD_FAILED', { lines });
  }

  // 5. spawn (zip mode)
  const tail = createTail();
  const argv = ['-r', WATCHDOG, cli, zip];
  let child;
  try {
    child = spawn(process.execPath, argv, { cwd: simDir, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  } catch (e) {
    try { await hub.stop(); } catch { /* best-effort */ }
    throw e;
  }
  if (child.pid) { try { fs.writeFileSync(pidFile, String(child.pid)); } catch { /* best-effort */ } }
  for (const s of [child.stdout, child.stderr]) if (s && s.on) s.on('data', (d) => tail.push(d));

  const startedAt = now();
  const st = { state: 'starting', exitCode: null, signal: null, stopped: false };
  let childGone = false;
  let exitResolve;
  const exited = new Promise((r) => { exitResolve = r; });
  let readyRes; let readyRej;
  const readyP = new Promise((res, rej) => { readyRes = res; readyRej = rej; });
  readyP.catch(() => {}); // callers that never call ready() must not trigger an unhandled rejection
  let timer = null;
  const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };

  child.on('error', (e) => { tail.push(`spawn error: ${e.message}`); });
  child.on('exit', (code, signal) => {
    childGone = true;
    st.exitCode = code; st.signal = signal || null;
    st.state = 'exited';
    stopTimer();
    readyRej(new SimulatorError(`simulator engine exited (${code !== null ? `code ${code}` : `signal ${signal}`}) before the app settled\n${tail.lines().join('\n')}`, 'SIM_EXITED'));
    exitResolve();
  });

  const tick = () => {
    if (st.state === 'exited' || st.stopped) return;
    const t = now();
    const hellos = hub.hellos || 0;
    if (hellos >= 1 && (st.state === 'starting' || st.state === 'no-hello')) st.state = 'settling';
    if (st.state === 'settling') {
      if (hub.lastHelloAt != null && t - hub.lastHelloAt >= settleMs) { st.state = 'running'; stopTimer(); readyRes(); }
    } else if (st.state === 'starting' && t - startedAt >= helloTimeoutMs) {
      st.state = 'no-hello';
      stopTimer();
      const hint = eng.flavor === 'patched' ? `\n${PATCHED_HINT}` : '';
      log(`[brighttest simulator] no agent.hello within ${helloTimeoutMs / 1000}s; engine output:\n${tail.lines().join('\n')}${hint}`);
      readyRej(new SimulatorError(`no agent.hello from the simulated app within ${helloTimeoutMs / 1000}s${hint}`, 'SIM_NO_HELLO'));
    }
  };
  timer = setInterval(tick, pollMs);
  if (timer.unref) timer.unref();

  // 8. exit wiring
  const killNow = () => { if (child && !childGone) { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
  const onExit = () => killNow();
  const sigHandlers = {};
  for (const sig of ['SIGINT', 'SIGTERM']) {
    sigHandlers[sig] = () => {
      killNow();
      process.removeListener(sig, sigHandlers[sig]);
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig); // keep the default behavior of the signal
    };
    process.on(sig, sigHandlers[sig]);
  }
  process.on('exit', onExit);
  const unwire = () => {
    process.removeListener('exit', onExit);
    for (const sig of Object.keys(sigHandlers)) process.removeListener(sig, sigHandlers[sig]);
  };

  let stopP = null;
  function stop() {
    if (stopP) return stopP;
    stopP = (async () => {
      st.stopped = true;
      stopTimer();
      if (!childGone) {
        try { child.kill('SIGTERM'); } catch { /* gone */ }
        let t;
        await Promise.race([exited, new Promise((r) => { t = setTimeout(r, killGraceMs); })]);
        clearTimeout(t);
        if (!childGone) { killNow(); await Promise.race([exited, new Promise((r) => setTimeout(r, killGraceMs).unref())]); }
      }
      st.state = 'exited';
      try { fs.unlinkSync(pidFile); } catch { /* none */ }
      unwire();
      try { await hub.stop(); } catch { /* best-effort */ }
    })();
    return stopP;
  }

  const net = {
    hub, proxy: null, redactPaths, events: hub.events, log: hub.log,
    hello: () => ({ hellos: hub.hellos || 0, lastHelloAt: hub.lastHelloAt == null ? null : hub.lastHelloAt }),
    redact: {},
  };

  return {
    net,
    info() {
      return {
        target: 'simulator',
        engine: { name: eng.name, version: eng.version, flavor: eng.flavor, source },
        pid: child.pid || null,
        state: st.state, exitCode: st.exitCode, tail: tail.lines(),
      };
    },
    ready: () => readyP,
    stop,
  };
}

module.exports = { startSimulator, SimulatorError, createTail, reapStale, WATCHDOG, SETTLE_MS, HELLO_TIMEOUT_MS, TAIL_LINES };
