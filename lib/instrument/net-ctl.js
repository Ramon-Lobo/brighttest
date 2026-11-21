'use strict';
const fs = require('fs');
const path = require('path');
const rules = require('./net-rules');

// Spec control API for the headless lanes (NET-N-T6; design network-interception.md 4.4). The hub routes
// POST /bt/<token>/ctl/net/<op> here; BTNet_spec.brs is the client. Node core only, no sockets: the hub does the
// peer, token and lease checks and the body read, this module turns (op, JSON body) into a rule-set or log action.
//
// ops: reset | mock | fault | fixture | requests. Replies are { status, json }. Every rule-level error
// (NetRuleError, a bad body, a fixture outside the project root) is a 400 { error }.
//
// BrightScript associative arrays are case-insensitive and may reach the wire with lower-cased keys, so the rule's own
// keys (not the contents of `json`, `headers` or `reqHeaders`) are mapped back to their canonical spelling.
// `reset` clears the run-time rules and hides the request log up to that point; config fixtures stay.

const RULE_KEYS = ['id', 'method', 'url', 'reqHeaders', 'reqBody', 'times', 'status', 'headers', 'body', 'json', 'file', 'bodyBase64',
  'delayMs', 'fault', 'kind', 'holdMs', 'partialBytes', 'responses', 'passthrough'];
const BODY_KEYS = ['contains', 'regex', 'json'];
const OPAQUE = new Set(['json', 'headers', 'reqHeaders']);

function canon(obj, keys) {
  const map = new Map(keys.map((k) => [k.toLowerCase(), k]));
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[map.get(k.toLowerCase()) || k] = v;
  return out;
}

function canonRule(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const r = canon(raw, RULE_KEYS);
  for (const k of Object.keys(r)) {
    if (OPAQUE.has(k)) continue;
    if (k === 'responses' && Array.isArray(r[k])) r[k] = r[k].map((x) => canonRule(x));
    else if (k === 'fault' && r[k] && typeof r[k] === 'object') r[k] = canon(r[k], ['kind', 'status', 'holdMs', 'partialBytes']);
    else if (k === 'reqBody' && r[k] && typeof r[k] === 'object') r[k] = canon(r[k], BODY_KEYS);
  }
  return r;
}

function createNetCtl({ proxy, root = null } = {}) {
  if (!proxy || !proxy.ruleSet || typeof proxy.requests !== 'function') throw new Error('createNetCtl: proxy must expose ruleSet and requests()');
  const ruleSet = proxy.ruleSet;
  const projectRoot = root || ruleSet.root || null;
  let hidden = new Set(); // request ids logged before the last reset

  function prep(raw) {
    const r = canonRule(raw);
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new rules.NetRuleError('rule must be an object');
    return r;
  }

  function fixturePath(rel) {
    if (typeof rel !== 'string' || !rel) throw new rules.NetRuleError('fixture path must be a non-empty string');
    if (!projectRoot) throw new rules.NetRuleError('BTNet_useFixture needs a project root');
    if (path.isAbsolute(rel)) throw new rules.NetRuleError(`fixture path "${rel}" must be relative to the project root`);
    const base = fs.realpathSync(projectRoot);
    let real;
    try { real = fs.realpathSync(path.resolve(base, rel)); } catch (e) { throw new rules.NetRuleError(`fixture not found: ${rel}`); }
    if (real !== base && !real.startsWith(base + path.sep)) throw new rules.NetRuleError(`fixture ${rel} resolves outside the project root`);
    return real;
  }

  function handle(op, bodyText) {
    try {
      let body = {};
      if (bodyText && bodyText.trim()) {
        try { body = JSON.parse(bodyText); } catch (e) { return { status: 400, json: { error: 'body is not valid JSON' } }; }
      }
      if (op === 'reset') {
        ruleSet.reset({});
        hidden = new Set(proxy.requests().map((e) => e.id));
        return { status: 200, json: { ok: true } };
      }
      if (op === 'mock') {
        const r = prep(body);
        if (r.kind !== undefined || r.fault !== undefined) throw new rules.NetRuleError('BTNet_mock takes a response; use BTNet_fault for faults');
        return { status: 200, json: { ok: true, id: ruleSet.add(r) } };
      }
      if (op === 'fault') {
        const r = prep(body);
        if (r.kind === undefined && r.fault === undefined) throw new rules.NetRuleError('BTNet_fault needs kind: "timeout" | "reset" | "status"');
        return { status: 200, json: { ok: true, id: ruleSet.add(r) } };
      }
      if (op === 'fixture') {
        const loaded = rules.loadRulesFile(fixturePath(body.path));
        const arr = Array.isArray(loaded) ? loaded : [loaded];
        // Added newest-first one by one in reverse so the file's own order (first match wins) is kept.
        const ids = [];
        for (let i = arr.length - 1; i >= 0; i--) ids.unshift(ruleSet.add(canonRule(arr[i])));
        return { status: 200, json: { ok: true, count: ids.length } };
      }
      if (op === 'requests') {
        const f = canon(body && typeof body === 'object' ? body : {}, ['method', 'url', 'status']);
        const list = proxy.requests(f).filter((e) => !hidden.has(e.id));
        return { status: 200, json: { requests: list } };
      }
      return { status: 404, json: { error: `unknown net op "${op}"` } };
    } catch (e) {
      if (e && e.name === 'NetRuleError') return { status: 400, json: { error: e.message } };
      throw e;
    }
  }

  return { handle };
}

module.exports = { createNetCtl, canonRule };
