'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rules = require('./net-rules');
const { createNetProxy } = require('./net-proxy');

// Headless-lane network session (NET-N-T5; design network-interception.md 4.4).
// prepare(cfg, opts) builds the rule set from `instrument.net.fixtures`, the proxy (mock / fault / passthrough /
// record) and the event list, or returns null when the run does not use `net`. headless.js hands session.proxy and
// session.token to the hub, and session.ctx(hub) to the build (BT_config.brs). finish() writes the run NDJSON
// (`<stagingDir>/net/last-run.ndjson`, redacted), the HAR when recording, and prints failing requests.

const NET_KEYS = ['fixtures', 'unmatched', 'upstreamHosts', 'redact'];
const POLICIES = ['fail', 'passthrough'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.brighttest']);

function netBlock(cfg) {
  const n = cfg && cfg.instrument && cfg.instrument.net;
  return n && typeof n === 'object' && !Array.isArray(n) ? n : {};
}

// True when the run needs the net hub: a --net-* flag, `instrument.net` set to true or to an object with a
// fixture-level key, or any spec that references BTNet_*. Without any of these a headless run is unchanged.
function isActive(cfg, opts = {}) {
  if (opts.netRecord || opts.netUnmatched) return true;
  const raw = cfg && cfg.instrument && cfg.instrument.net;
  if (raw === true) return true;
  const n = netBlock(cfg);
  if (NET_KEYS.some((k) => n[k] !== undefined)) return true;
  return require('../config').findNetSpecs(cfg).length > 0;
}

function globToRegex(glob) {
  let re = '';
  const g = glob.replace(/\\/g, '/');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; } } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function walkFiles(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walkFiles(p, out); } else out.push(p);
  }
  return out;
}

// Expand fixture patterns (declaration order, each pattern's matches sorted) confined to the project root.
function expandFixtures(root, patterns) {
  if (patterns === undefined) return [];
  if (!Array.isArray(patterns) || !patterns.every((p) => typeof p === 'string')) throw new rules.NetRuleError('instrument.net.fixtures must be an array of glob strings');
  const realRoot = fs.realpathSync(root);
  const all = walkFiles(root).map((f) => ({ abs: f, rel: path.relative(root, f).split(path.sep).join('/') }));
  const out = [];
  for (const pat of patterns) {
    if (path.isAbsolute(pat) || pat.split(/[\\/]/).includes('..')) throw new rules.NetRuleError(`instrument.net.fixtures pattern "${pat}" must stay inside the project root`);
    const re = globToRegex(pat.replace(/^\.\//, ''));
    const hits = all.filter((f) => re.test(f.rel));
    if (!hits.length) throw new rules.NetRuleError(`instrument.net.fixtures pattern "${pat}" matched no files`);
    for (const h of hits) {
      const real = fs.realpathSync(h.abs);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new rules.NetRuleError(`fixture ${h.rel} resolves outside the project root`);
      if (!out.includes(h.abs)) out.push(h.abs);
    }
  }
  return out;
}

function runId() { return new Date().toISOString().replace(/[:.]/g, '-'); }

function prepare(cfg, opts = {}, { log = (m) => process.stdout.write(`${m}\n`), warn = (m) => process.stderr.write(`${m}\n`) } = {}) {
  if (!isActive(cfg, opts)) return null;
  const n = netBlock(cfg);
  if (opts.netUnmatched !== undefined && !POLICIES.includes(opts.netUnmatched)) throw new rules.NetRuleError('--net-unmatched must be "fail" or "passthrough"');
  if (n.unmatched !== undefined && !POLICIES.includes(n.unmatched)) throw new rules.NetRuleError('instrument.net.unmatched must be "fail" or "passthrough"');
  const root = cfg.rootDir;
  const netDir = path.join(cfg.stagingDir, 'net');
  const ruleSet = rules.createRuleSet({ root });
  const files = expandFixtures(root, n.fixtures);
  for (const f of files) ruleSet.addConfig(rules.loadRulesFile(f), { source: 'fixture' });

  const record = !!opts.netRecord;
  const recordFile = record ? path.resolve(typeof opts.netRecord === 'string' ? opts.netRecord : path.join(netDir, `${runId()}.har`)) : null;
  const unmatched = opts.netUnmatched || n.unmatched || (record ? 'passthrough' : undefined);
  const upstreamHosts = Array.isArray(n.upstreamHosts) ? n.upstreamHosts : [];
  const events = [];
  const emit = (kind, data) => { events.push({ v: 1, ts: new Date().toISOString(), kind, data: { ...data, lane: 'headless' } }); };
  const proxy = createNetProxy({
    ruleSet, root, emit, upstreamHosts, record, unmatched, redact: n.redact || {}, warn, bodyDir: path.join(netDir, 'bodies'),
  });
  if (record) log(`[brighttest] net: recording passthrough traffic to ${recordFile}; upstream hosts: ${proxy.allowedHosts().join(', ')}`);

  const token = crypto.randomBytes(16).toString('hex');
  let finished = false;
  return {
    token, proxy, ruleSet, events, recordFile, fixtureFiles: files,
    ctx(hub) { return { token, host: hub.host, port: hub.port }; },
    // Writes the NDJSON (+ HAR) and prints the failing requests. Safe to call twice.
    finish() {
      if (finished) return { failing: [] };
      finished = true;
      proxy.close();
      fs.mkdirSync(netDir, { recursive: true });
      const ndjson = path.join(netDir, 'last-run.ndjson');
      fs.writeFileSync(ndjson, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
      let recorded = 0;
      if (record) {
        recorded = proxy.writeHar(recordFile);
        log(`[brighttest] net: recorded ${recorded} request(s) to ${recordFile}`);
      }
      const failing = events.filter((e) => e.kind === 'net.error');
      if (failing.length) {
        log(`\n  Network failures (${failing.length})`);
        for (const e of failing.slice(0, 20)) log(`    ${e.data.kind}: ${e.data.detail || ''}`);
        if (failing.length > 20) log(`    ... and ${failing.length - 20} more (see ${ndjson})`);
      }
      return { failing, ndjson, recorded };
    },
  };
}

module.exports = { prepare, isActive, expandFixtures };
