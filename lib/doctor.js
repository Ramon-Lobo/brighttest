'use strict';
// `brighttest doctor`: read-only device capability check with exact fix texts, plus the shared
// preflight the e2e lane uses to fail fast before any launch or keypress. Only GET /query/device-info
// is issued (no auth, no lease needed). The dev password is never read here, and the serial number is
// parsed but printed only with --show-serial.
const { palette } = require('./reporter');
const { createDevice } = require('./e2e/ecp');
const { resolveDevice, resolveEcpPort } = require('./devices');

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
    developerEnabled: caps.developerEnabled, ecpSettingMode: caps.ecpSettingMode, videoMode: caps.videoMode,
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

function render(r, c, showSerial) {
  const out = [];
  if (!r.reachable) {
    out.push(c.red(`✗ ${r.host}: not reachable (${r.error})`));
  } else {
    out.push(c.dim(`device: ${r.model || '?'} · ${r.deviceClass || '?'} · ${r.host}`));
    out.push(`  firmware:   ${r.softwareVersion || '?'}${r.build ? ` (build ${r.build})` : ''}`);
    out.push(`  ECP mode:   ${r.ecpSettingMode || '?'}`);
    out.push(`  developer:  ${r.developerEnabled === null ? '?' : r.developerEnabled ? 'enabled' : 'disabled'}`);
    out.push(`  video mode: ${r.videoMode || '?'}`);
    if (showSerial) out.push(`  serial:     ${r.serial || '?'}`);
  }
  for (const k of r.checks) {
    if (!k.ok) out.push(c.red(`✗ ${k.id}`) + `\n    fix: ${k.fix}`);
    else if (r.reachable) out.push(c.green(`✓ ${k.id}`) + (k.note ? c.dim(` (${k.note})`) : ''));
  }
  return out.join('\n') + '\n';
}

// opts: { host, ecpPort, json, showSerial, password(ignored) }. Returns the exit code (0 only when all checks pass).
async function run(opts = {}, deps = {}) {
  const r0 = resolveDevice({ host: opts.host, password: null });
  const host = r0.host;
  if (!host) { process.stderr.write('[brighttest doctor] no device host: pass --host or set ROKU_HOST\n'); return 2; }
  const r = await inspectDevice(host, resolveEcpPort(opts.ecpPort), deps);
  if (r.reachable) {
    const b = await (deps.probeBind || probeBind)();
    r.checks.push({ id: 'hub-bind', ok: !!b.ok, fix: b.ok ? null : FIX_HUB_BIND(b.error), note: b.ok ? HUB_NOTE : null });
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

module.exports = { run, preflight, evaluate, inspectDevice, deviceClass, probeBind, HUB_NOTE, FIX_HUB_BIND, FIX_LIMITED, FIX_ECP_DISABLED, FIX_DEV_DISABLED };
