'use strict';
// GET /api/settings (STUDIO-SET-T1): the read-mostly "effective settings" page. Pure given its inputs: no device
// call, no lease, no write. It reports where each value came from and never carries a password, a hub token, a
// serial or a lease id (only "known / set / not set" and the name of the place).
const fs = require('fs');
const path = require('path');
const devices = require('../devices');

// The brighttest.json as written (not merged with defaults), so a key can be called "default" or "brighttest.json".
function readRawConfig(rootDir) {
  const file = path.join(rootDir, 'brighttest.json');
  try { return { file, raw: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return { file: fs.existsSync(file) ? file : null, raw: {} }; }
}

// Where the device password came from: flag, env (ROKU_PASSWORD), dotenv, the device cache, or none. Never the value.
function passwordSource({ host, flagPassword, rootDir, env = process.env, connected = false }) {
  if (connected) return { known: true, source: 'connect' };
  if (flagPassword) return { known: true, source: 'flag' };
  if (env.ROKU_PASSWORD) return { known: true, source: 'env' };
  if (devices.loadDotEnv(rootDir).ROKU_PASSWORD) return { known: true, source: 'dotenv' };
  if (host && devices.cachedPassword(host)) return { known: true, source: 'cache' };
  return { known: false, source: 'none' };
}

const HUB_TOKEN_RE = /^[0-9a-f]{32}$/;
function hubTokenState(env = process.env) {
  const v = env.BRIGHTTEST_HUB_TOKEN;
  if (v === undefined || v === '') return 'unset';
  return typeof v === 'string' && HUB_TOKEN_RE.test(v) ? 'set' : 'malformed';
}

function leaseSettings({ cfg, raw, env = process.env }) {
  const L = require('../device-lease');
  const s = L.resolveSettings({ cfg, env });
  const given = (raw && raw.deviceLease) || {};
  const src = (key, envName) => (envName && env[envName] ? 'env' : given[key] !== undefined ? 'brighttest.json' : 'default');
  const dur = (key, ms, envName) => ({ value: given[key] !== undefined && !(envName && env[envName]) ? given[key] : L.formatDuration(ms), ms, source: src(key, envName) });
  return {
    enabled: { value: s.enabled, source: src('enabled') },
    wait: dur('wait', s.waitMs, 'BRIGHTTEST_LEASE_WAIT'),
    maxHold: dur('maxHold', s.maxHoldMs),
    studioIdle: dur('studioIdle', s.studioIdleMs),
    studioYield: dur('studioYield', s.studioYieldMs),
  };
}

function netRedactionOn(cfg) {
  try {
    const nb = (cfg && cfg.instrument && cfg.instrument.net) || {};
    const rules = require('../instrument/net-rules');
    return !!rules.makeRedactor({ ...(typeof nb === 'object' && nb.redact ? nb.redact : {}), warn: () => {} }).enabled;
  } catch { return null; }
}

function engineList(cfg) {
  const engines = require('../engines');
  const out = [];
  for (const kind of ['brsNode', 'rooibos']) {
    try { const e = engines.engineFor(kind, cfg); out.push({ kind, name: e.name, version: e.version, flavor: e.flavor }); }
    catch { out.push({ kind, name: null, version: null, flavor: null }); }
  }
  return out;
}

// ctx: { rootDir, flowsRoot, cfg, host, hostSource, flagPassword, connected, sim, pool, poolHosts, port, portFallback,
//        app, hubCtl, hubNet, hubEnv, holding, uiBuilt, env }
function buildSettings(ctx) {
  const env = ctx.env || process.env;
  const { file, raw } = readRawConfig(ctx.rootDir);
  const cfg = ctx.cfg || null;
  const dot = devices.loadDotEnv(ctx.rootDir);
  const cached = ctx.host ? devices.cachedDevices().find((d) => d.host === ctx.host) : null;
  const target = ctx.sim ? 'simulator' : ctx.pool ? 'pool' : ctx.host ? 'device' : 'none';

  // Hub
  const tok = hubTokenState(ctx.hubEnv || env);
  let addr = null; let addrErr = null;
  try { addr = require('../instrument/hub').hubAddress(cfg); } catch (e) { addrErr = e.message; }
  let up = false; let reason = null;
  if (ctx.sim) { up = !!(ctx.hubNet || (ctx.sim && ctx.sim.net)); reason = up ? null : 'the simulator started without a hub'; }
  else if (ctx.hubNet) up = true;
  else if (ctx.pool) reason = 'pool mode: the hub is not started when Studio uses a device pool (deviceLease.pool); start Studio with --host <ip>';
  else if (!ctx.host) reason = 'no device: the hub starts while Studio holds the device lease';
  else if (tok !== 'set') reason = `${tok === 'unset' ? 'BRIGHTTEST_HUB_TOKEN is not set' : 'BRIGHTTEST_HUB_TOKEN is not 32 lowercase hex characters'}`;
  else if (addrErr) reason = addrErr;
  else if (!ctx.holding) reason = 'Studio does not hold the device lease: the hub starts when it takes it';
  else reason = (ctx.hubCtl && ctx.hubCtl.message()) || 'the hub is not running';

  const statePaths = (cfg && cfg.instrument && cfg.instrument.state && cfg.instrument.state.redact && Array.isArray(cfg.instrument.state.redact.paths))
    ? cfg.instrument.state.redact.paths.filter((v) => typeof v === 'string') : [];
  const pkg = require('../../package.json');
  const lease = leaseSettings({ cfg, raw, env });
  return {
    device: {
      target, host: ctx.host || null, source: ctx.sim ? 'simulator' : ctx.pool ? 'pool' : ctx.host ? ctx.hostSource || 'unknown' : 'none',
      name: cached ? cached.name || null : null, model: ctx.model || null,
      projectDefault: dot.ROKU_HOST || null, dotenvPath: dot.ROKU_HOST ? path.join(ctx.rootDir, '.env') : null,
    },
    password: ctx.sim ? { known: false, source: 'n/a' } : passwordSource({ host: ctx.host, flagPassword: ctx.flagPassword, rootDir: ctx.rootDir, env, connected: ctx.connected }),
    lease: { ...lease, pool: { value: ctx.poolHosts || [], source: raw.deviceLease && raw.deviceLease.pool !== undefined ? 'brighttest.json' : 'default' }, holding: !!ctx.holding },
    hub: { up, reason: up ? null : reason, host: addr ? addr.host : null, port: addr ? addr.port : null, net: !!(cfg && cfg.instrument && cfg.instrument.net) },
    hubToken: tok,
    project: {
      rootDir: ctx.rootDir, flowsDir: ctx.flowsRoot, configFile: file, port: ctx.port, portFallback: !!ctx.portFallback,
      app: ctx.app || null, target,
    },
    redaction: { statePaths, net: netRedactionOn(cfg) },
    about: { version: pkg.version, node: process.version, engines: engineList(cfg), uiBuilt: !!ctx.uiBuilt },
  };
}

module.exports = { buildSettings, passwordSource, hubTokenState, readRawConfig, leaseSettings };
