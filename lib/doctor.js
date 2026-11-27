'use strict';
// `brighttest doctor`: read-only device capability check with exact fix texts, plus the shared
// preflight the e2e lane uses to fail fast before any launch or keypress. Only GET /query/device-info
// is issued (no auth, no lease needed) unless BRIGHTTEST_DOCTOR_HUB_PROBE=1 opts in to the hub reach probe (ADR 0024:
// password, lease, replaces the dev channel). Without the opt-in the dev password is never used here, and the serial number is
// parsed but printed only with --show-serial.
const { palette } = require('./reporter');
const { createDevice } = require('./e2e/ecp');
const { resolveDevice, resolveEcpPort } = require('./devices');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIX_LIMITED =
  'Set the device to Permissive: Settings → System → Advanced system settings → Control by mobile apps → Network access → Permissive.';
const FIX_ECP_DISABLED =
  'ECP is disabled. Enable it: Settings → System → Advanced system settings → Control by mobile apps → Network access → Permissive.';
const FIX_DEV_DISABLED =
  'Enable developer mode: on the remote press Home x3, Up x2, Right, Left, Right, Left, Right, then enable the installer and set a web server password.';

function deviceClass(c) {
  if (c.isTv === true) return 'tv';
  if (c.isStick === true) return 'stick';
  if (c.isTv === false || c.isStick === false) return 'box';
  return null;
}

// Pure: capability record -> checks [{ id, ok, fix }]. `ok` is false only on a definite bad value.
function evaluate(c) {
  const mode = c.ecpSettingMode;
  const ecp = mode === 'limited' ? FIX_LIMITED : mode === 'disabled' ? FIX_ECP_DISABLED : null;
  return [
    { id: 'ecp-mode', ok: !ecp, fix: ecp },
    { id: 'developer-mode', ok: c.developerEnabled !== false, fix: c.developerEnabled === false ? FIX_DEV_DISABLED : null },
  ];
}

const fixReachable = (host, ecpPort) =>
  `No answer from ${host}. Check it is powered on, on this network, and that ECP (port ${ecpPort}) is reachable.`;

// e2e preflight: null when fine (or when the device cannot say), else the failing checks' fix texts.
// An unreachable device (no HTTP answer at all) throws with the `reachable` fix text (ADR 0007, owner
// decision E-107). A device that answers but not with a usable record (non-200) keeps returning null.
async function preflight(device) {
  if (!device || typeof device.deviceCapabilities !== 'function') return null;
  let caps;
  try { caps = await device.deviceCapabilities(); }
  catch (e) {
    if (e && e.httpStatus != null) return null; // answered, but cannot say: the run reports it
    const host = device.host || 'the device';
    const err = new Error(`[${host}] preflight failed: not reachable (${e && e.message}). ${fixReachable(host, device.ecpPort || 8060)}`);
    err.code = 'DEVICE_UNREACHABLE';
    err.fix = fixReachable(host, device.ecpPort || 8060);
    throw err;
  }
  const bad = evaluate(caps).filter((k) => !k.ok);
  return bad.length ? bad : null;
}

async function inspectDevice(host, ecpPort, deps = {}) {
  const device = (deps.createDevice || createDevice)({ host, password: null, ecpPort });
  let caps;
  try { caps = await device.deviceCapabilities(); }
  catch (e) {
    return { host, reachable: false, error: e.message, checks: [{ id: 'reachable', ok: false, fix: fixReachable(host, ecpPort) }] };
  }
  return {
    host, reachable: true, model: caps.model, softwareVersion: caps.softwareVersion, build: caps.softwareBuild,
    developerEnabled: caps.developerEnabled, ecpSettingMode: caps.ecpSettingMode, videoMode: caps.videoMode, videoModeSource: caps.videoModeSource,
    uiResolution: caps.uiResolution, deviceClass: deviceClass(caps), brightscriptDebuggerVersion: caps.brightscriptDebuggerVersion,
    serial: caps.serial, checks: [{ id: 'reachable', ok: true, fix: null }, ...evaluate(caps)],
  };
}

// Hub bind check (NET-N-T8). Local only: can this machine open a listener on all interfaces? It cannot prove the
// device-to-hub path (firewall, Wi-Fi isolation); the proof is the first device case of the network test pack.
const HUB_NOTE = 'checked locally: bind only; the device-to-hub path is not proved here (it is proved on a device with an instrumented build)';
const FIX_HUB_BIND = (err) => `The instrument hub could not bind a TCP port on this machine (${err}). Free up local ports or check that a firewall or VPN is not blocking listeners, then run doctor again.`;
function probeBind() {
  return new Promise((resolve) => {
    const srv = require('net').createServer();
    srv.once('error', (e) => resolve({ ok: false, error: e.message }));
    srv.listen(0, '0.0.0.0', () => { const port = srv.address().port; srv.close(() => resolve({ ok: true, address: '0.0.0.0', port })); });
  });
}

// Device-to-hub reach (ADR 0024). Default doctor proves nothing here (read-only, no password, no lease). With
// BRIGHTTEST_DOCTOR_HUB_PROBE=1 it sideloads a tiny probe channel (REPLACING the dev slot) that GETs this machine's
// advertised hub address; a short-lived listener on the hub port sees (or does not see) the device's request.
const HUB_REACH_LINE = 'hub reach: not tested (set BRIGHTTEST_DOCTOR_HUB_PROBE=1 and ROKU_PASSWORD; replaces the dev channel)';
const FIX_HUB_REACH = (host, port) =>
  `The device did not reach ${host}:${port} on this machine. Check that (1) the local firewall allows inbound TCP ${port} for node, (2) this machine and the device are on the same network without Wi-Fi client or guest isolation, (3) no VPN captures the LAN route, (4) ${host} is this machine's address on the device's network (several interfaces: set instrument.hub.host). Doctor never changes these.`;
const PROBE_NOTE = 'dev channel now holds the brighttest probe; re-sideload your app';
const PROBE_WAIT_MS = 15000;
const REASON_TEXT = {
  'device-unreachable': 'device did not answer', 'developer-disabled': 'developer mode is disabled', 'no-password': 'no ROKU_PASSWORD',
  'port-busy': 'hub port is busy on this machine', 'lease-busy': 'device lease not available', 'sideload-failed': 'probe sideload failed',
};

const PROBE_MANIFEST = 'title=brighttest hub probe\nmajor_version=1\nminor_version=0\nbuild_version=1\nsplash_min_time=0\n';
const PROBE_SCENE_XML = `<?xml version="1.0" encoding="utf-8" ?>
<component name="ProbeScene" extends="Scene">
  <children><Label id="msg" text="brighttest hub probe" translation="[100,100]" /></children>
</component>
`;
const probeMainBrs = (url) => `sub main()
  screen = CreateObject("roSGScreen")
  port = CreateObject("roMessagePort")
  screen.SetMessagePort(port)
  screen.CreateScene("ProbeScene")
  screen.Show()
  for attempt = 1 to 2
    xfer = CreateObject("roUrlTransfer")
    xfer.SetMessagePort(port)
    xfer.SetUrl("${url}")
    xfer.AsyncGetToString()
    msg = wait(5000, port)
    if type(msg) = "roUrlEvent" then
      print "BT_PROBE " + msg.GetResponseCode().ToStr() + " " + msg.GetFailureReason()
      if msg.GetResponseCode() = 204 then exit for
    else
      xfer.AsyncCancel()
      print "BT_PROBE 0 timeout"
    end if
    if attempt = 1 then sleep(2000)
  end for
  while true
    msg = wait(0, port)
    if type(msg) = "roSGScreenEvent" and msg.isScreenClosed() then return
  end while
end sub
`;

async function buildProbeZip(url) {
  const zip = new (require('jszip'))();
  zip.file('manifest', PROBE_MANIFEST);
  zip.file('source/main.brs', probeMainBrs(url));
  zip.file('components/ProbeScene.xml', PROBE_SCENE_XML);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// Short-lived listener, bound like the LAN hub. 204 only to GET /bt-probe/<nonce> from the device; 404 otherwise.
function listenForProbe({ port, deviceHost, nonce, bindHost = '0.0.0.0', peerOf = null }) {
  return new Promise((resolve) => {
    let hit = false;
    const waiters = new Set();
    const srv = require('http').createServer((req, res) => {
      const peer = String(peerOf ? peerOf(req) : req.socket.remoteAddress).replace(/^::ffff:/, '');
      if (req.method === 'GET' && req.url === `/bt-probe/${nonce}` && peer === deviceHost) {
        res.statusCode = 204; res.end();
        hit = true; for (const w of waiters) w(true);
      } else { res.statusCode = 404; res.end(); }
    });
    srv.once('error', (e) => resolve({ ok: false, error: e.code === 'EADDRINUSE' ? 'port-busy' : e.message }));
    srv.listen(port, bindHost, () => resolve({
      ok: true,
      waitHit: (ms) => new Promise((res) => {
        if (hit) return res(true);
        const done = (v) => { clearTimeout(t); waiters.delete(done); res(v); };
        const t = setTimeout(() => done(hit), ms);
        waiters.add(done);
      }),
      close: () => new Promise((res) => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(() => res()); }),
    }));
  });
}

const notTested = (reachReason, detail) => ({ reach: 'not-tested', reachReason, ...(detail ? { detail } : {}) });

// Lease -> listener -> zip -> sideload -> wait -> Home -> cleanup. Never throws; password never leaves this function.
async function probeHubReach({ host, ecpPort, password, port, advertisedHost, env = process.env }, deps = {}) {
  const acquire = deps.acquireForLane || require('./device-command').acquireForLane;
  const sideload = deps.sideload || require('./instrument/sideload').sideload;
  const scrub = (t) => (password ? String(t).split(password).join('***') : String(t));
  const got = await acquire({ host, ecpPort, password, purpose: 'doctor hub probe', command: ['brighttest', 'doctor'], allowBypass: false, env });
  if (got.code != null) return notTested('lease-busy', `lease exit ${got.code}`);
  const lease = got.lease;
  let srv = null, dir = null;
  try {
    const nonce = (deps.randomBytes || require('crypto').randomBytes)(16).toString('hex');
    srv = await (deps.listen || listenForProbe)({ port, deviceHost: host, nonce });
    if (!srv.ok) return notTested(srv.error === 'port-busy' ? 'port-busy' : 'sideload-failed', srv.error);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-probe-'));
    const zip = path.join(dir, 'probe.zip');
    fs.writeFileSync(zip, await buildProbeZip(`http://${advertisedHost}:${port}/bt-probe/${nonce}`));
    const lines = [];
    // The inner acquire is re-entrant under the outer lease, so its release is a no-op (ADR 0024 §4).
    const inner = (a) => acquire({ ...a, env: { ...process.env, BRIGHTTEST_LEASE: lease ? lease.leaseId : undefined } });
    const code = await sideload(null, { zip, host, password }, { acquireForLane: inner, log: (l) => lines.push(scrub(l)) });
    if (code !== 0) return notTested('sideload-failed', lines.join('\n') || `sideload exit ${code}`);
    const hit = await srv.waitHit(deps.waitMs ?? PROBE_WAIT_MS);
    try { await (deps.createDevice || createDevice)({ host, password, ecpPort }).keypress('Home'); } catch { /* best effort */ }
    return { reach: hit ? 'reached' : 'not-reached', probeInstalled: true };
  } catch (e) {
    return notTested('sideload-failed', scrub(e && e.message));
  } finally {
    if (srv && srv.close) await srv.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if (lease && lease.release) lease.release();
  }
}

const SOURCE_TEXT = { flag: '--host', env: 'ROKU_HOST in the environment', dotenv: 'ROKU_HOST in .env', cache: 'the cached device' };

// Where the host came from, plus warnings about a pick the lanes would not make (D5). Pure given its inputs.
function hostSourceInfo(r0, cachedCount) {
  const warnings = [];
  if (r0.source === 'cache' && cachedCount > 1) warnings.push('several devices are cached and no host was given: doctor used the last one; pass --host <ip> or set ROKU_HOST (brighttest setup) to choose');
  if ((r0.source === 'env' || r0.source === 'dotenv') && /[:,]/.test(String(r0.host))) warnings.push('ROKU_HOST contains ":" or ",": only e2e run accepts ip:pw or a list; use one bare IP (brighttest setup)');
  return { hostSource: r0.source, ...(r0.dotenvPath ? { hostSourcePath: r0.dotenvPath } : {}), warnings };
}

// Environment section (QS-T4): names, set/unset and where each came from; never a value of anything secret.
const BEHAVIOUR_VARS = ['BRIGHTTEST_AGENT', 'BRIGHTTEST_PURPOSE', 'BRIGHTTEST_LEASE', 'BRIGHTTEST_LEASE_WAIT', 'BRIGHTTEST_LEASE_DIR', 'BRIGHTTEST_NO_LEASE', 'BRIGHTTEST_ENGINES', 'BRIGHTTEST_CACHE', 'BRIGHTTEST_DOCTOR_HUB_PROBE', 'ROKU_ECP_PORT'];
function environmentReport(r0, { env = process.env, dot = {} } = {}) {
  const where = (k) => (env[k] ? 'shell' : dot[k] ? '.env' : null);
  const items = [];
  const hostSrc = r0.source === 'flag' ? 'flag' : r0.source === 'env' ? 'shell' : r0.source === 'dotenv' ? '.env' : r0.source === 'cache' ? 'cache' : null;
  const bad = r0.host && /[:,]/.test(String(r0.host)) && r0.source !== 'flag';
  items.push({
    name: 'ROKU_HOST', set: !!(env.ROKU_HOST || dot.ROKU_HOST), source: hostSrc, status: !r0.host ? 'missing' : bad ? 'malformed' : 'ok',
    note: !r0.host ? 'no device host: run `brighttest setup`, or pass --host' : bad ? 'must be one bare IP; ip:pw and lists work only for e2e run (run `brighttest setup`)' : (hostSrc === 'cache' ? 'not set; using the cached device (run `brighttest setup` to pin one)' : null),
  });
  const pw = where('ROKU_PASSWORD');
  items.push({ name: 'ROKU_PASSWORD', set: !!pw, source: pw, status: pw ? 'ok' : 'unset', note: pw ? null : 'only needed for sideload, instrument and screenshots; set it or run `brighttest devices` to cache it' });
  const tok = env.BRIGHTTEST_HUB_TOKEN;
  const hubOk = typeof tok === 'string' && /^[0-9a-f]{32}$/.test(tok);
  items.push({ name: 'BRIGHTTEST_HUB_TOKEN', set: tok !== undefined && tok !== '', source: tok ? 'shell' : null, status: !tok ? 'unset' : hubOk ? 'ok' : 'malformed', note: !tok ? 'only needed for an instrumented build with network capture' : hubOk ? null : 'must be 32 lowercase hex characters' });
  for (const k of BEHAVIOUR_VARS) if (env[k] !== undefined && env[k] !== '') items.push({ name: k, set: true, source: 'shell', status: 'ok', note: null });
  return items;
}

function renderEnvironment(items, c) {
  const out = [c.dim('environment:')];
  for (const i of items) {
    const st = i.status === 'ok' ? 'set' : i.set ? i.status : 'unset';
    const line = `  ${i.name}: ${i.status === 'malformed' ? c.red(st) : st}${i.source ? c.dim(` (${i.source})`) : ''}${i.note ? c.dim(` - ${i.note}`) : ''}`;
    out.push(line);
  }
  return out;
}

function render(r, c, showSerial) {
  const out = [];
  if (r.hostSource && r.hostSource !== 'none') out.push(c.dim(`host: ${r.host} (from ${SOURCE_TEXT[r.hostSource] || r.hostSource})`));
  for (const w of r.hostWarnings || []) out.push(c.yellow(`warning: ${w}`));
  if (r.environment) out.push(...renderEnvironment(r.environment, c));
  if (!r.reachable) {
    out.push(c.red(`✗ ${r.host}: not reachable (${r.error})`));
  } else {
    out.push(c.dim(`device: ${r.model || '?'} · ${r.deviceClass || '?'} · ${r.host}`));
    out.push(`  firmware:   ${r.softwareVersion || '?'}${r.build ? ` (build ${r.build})` : ''}`);
    out.push(`  ECP mode:   ${r.ecpSettingMode || '?'}`);
    out.push(`  developer:  ${r.developerEnabled === null ? '?' : r.developerEnabled ? 'enabled' : 'disabled'}`);
    out.push(`  video mode: ${r.videoMode || '?'}${r.videoModeSource === 'ui-resolution' ? ' (ui-resolution; no video-mode)' : ''}`);
    if (showSerial) out.push(`  serial:     ${r.serial || '?'}`);
  }
  for (const k of r.checks) {
    if (!k.ok) out.push(c.red(`✗ ${k.id}`) + `\n    fix: ${k.fix}`);
    else if (r.reachable) out.push(c.green(`✓ ${k.id}`) + (k.note ? c.dim(` (${k.note})`) : ''));
  }
  if (r.hub) {
    const h = r.hub;
    if (h.bindAddress) out.push(c.dim(`hub: bind ${h.bindAddress}:${h.port} (default port; instrument.hub.port overrides); would advertise ${h.advertisedHost || 'no LAN address found'}`));
    if (h.reach === 'reached') out.push(c.green(`✓ hub reach: the device reached ${h.advertisedHost}:${h.port}`));
    else if (h.reach === 'not-reached') out.push(c.red(`✗ hub reach: the device did not reach ${h.advertisedHost}:${h.port}`));
    else if (h.reachReason && h.reachReason !== 'not-requested') out.push(c.yellow(`hub reach: not tested (${REASON_TEXT[h.reachReason] || h.reachReason})`));
    else out.push(c.yellow(HUB_REACH_LINE));
    if (h.probeInstalled) out.push(c.dim(PROBE_NOTE));
  }
  return out.join('\n') + '\n';
}

// opts: { host, ecpPort, json, showSerial, password(ignored) }. Returns the exit code (0 only when all checks pass).
async function run(opts = {}, deps = {}) {
  const r0 = resolveDevice({ host: opts.host, password: null });
  const host = r0.host;
  if (!host) { process.stderr.write('[brighttest doctor] no device host: pass --host, set ROKU_HOST (environment or project .env), or run `brighttest setup`\n'); return 2; }
  const ecpPort = resolveEcpPort(opts.ecpPort);
  const r = await inspectDevice(host, ecpPort, deps);
  const hs = hostSourceInfo(r0, require('./devices').cachedDevices().length);
  r.hostSource = hs.hostSource; if (hs.hostSourcePath) r.hostSourcePath = hs.hostSourcePath; r.hostWarnings = hs.warnings;
  r.environment = environmentReport(r0, { env: deps.env ?? process.env, dot: require('./devices').loadDotEnv(process.cwd()) });
  const wantProbe = ((deps.env ?? process.env).BRIGHTTEST_DOCTOR_HUB_PROBE === '1');
  if (!r.reachable && wantProbe) r.hub = { reach: 'not-tested', reachReason: 'device-unreachable', reachProven: false };
  if (r.reachable) {
    const b = await (deps.probeBind || probeBind)();
    const hubMod = require('./instrument/hub');
    r.hub = { bindAddress: b.address || '0.0.0.0', port: hubMod.DEFAULT_HUB_PORT, advertisedHost: (deps.lanHost || hubMod.lanHost)(), reach: 'not-tested', reachReason: 'not-requested', reachProven: false };
    r.checks.push({ id: 'hub-bind', ok: !!b.ok, fix: b.ok ? null : FIX_HUB_BIND(b.error), note: b.ok ? HUB_NOTE : null });
    if (wantProbe) {
      const dev = (deps.resolveDevice || resolveDevice)({ host, password: null });
      const dis = r.checks.find((k) => k.id === 'developer-mode' && !k.ok);
      const res = dis ? notTested('developer-disabled') : !dev.password ? notTested('no-password')
        : !r.hub.advertisedHost ? notTested('sideload-failed', 'no LAN address found')
        : await probeHubReach({ host, ecpPort, password: dev.password, port: r.hub.port, advertisedHost: r.hub.advertisedHost, env: deps.env ?? process.env }, deps);
      r.hub.reach = res.reach; r.hub.reachReason = res.reachReason || null; r.hub.reachProven = res.reach === 'reached';
      if (res.probeInstalled) r.hub.probeInstalled = true;
      if (res.reach === 'reached') r.checks.push({ id: 'hub-reach', ok: true, fix: null });
      else if (res.reach === 'not-reached') r.checks.push({ id: 'hub-reach', ok: false, fix: FIX_HUB_REACH(r.hub.advertisedHost, r.hub.port) });
    }
  }
  const ok = r.checks.every((k) => k.ok);
  if (opts.json) {
    const rec = { ...r };
    if (!opts.showSerial) delete rec.serial;
    process.stdout.write(JSON.stringify(rec, null, 2) + '\n');
  } else {
    process.stdout.write(render(r, palette(!!process.stdout.isTTY), !!opts.showSerial));
  }
  return ok ? 0 : 1;
}

module.exports = { run, environmentReport, preflight, evaluate, inspectDevice, deviceClass, probeBind, HUB_NOTE, HUB_REACH_LINE, FIX_HUB_BIND, FIX_HUB_REACH, PROBE_MANIFEST, PROBE_SCENE_XML, PROBE_WAIT_MS, probeMainBrs, buildProbeZip, listenForProbe, probeHubReach, FIX_LIMITED, FIX_ECP_DISABLED, FIX_DEV_DISABLED };
