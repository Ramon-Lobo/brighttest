import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const R = require('../lib/instrument/net-rules.js');

const GET = (url, extra = {}) => ({ method: 'GET', url, headers: {}, body: '', ...extra });
function set(rules, root) { const s = R.createRuleSet({ root }); s.addConfig(rules); return s; }

describe('url globs', () => {
  it('* stays within a segment, ** crosses segments', () => {
    expect(R.urlMatches('https://h.test/v1/*', 'https://h.test/v1/home')).toBe(true);
    expect(R.urlMatches('https://h.test/v1/*', 'https://h.test/v1/a/b')).toBe(false);
    expect(R.urlMatches('https://h.test/v1/**', 'https://h.test/v1/a/b')).toBe(true);
    expect(R.urlMatches('**/v1/config', 'https://h.test/v1/config')).toBe(true);
    expect(R.urlMatches('/v1/config', 'https://h.test/v1/config')).toBe(true);
    expect(R.urlMatches('https://h.test/v1/home*', 'https://h.test/v1/home?x=1')).toBe(true);
  });
  it('host is case-insensitive, path is not; literal star escapes', () => {
    expect(R.urlMatches('https://H.TEST/a', 'https://h.test/a')).toBe(true);
    expect(R.urlMatches('https://h.test/A', 'https://h.test/a')).toBe(false);
    expect(R.urlMatches('https://h.test/a\\*', 'https://h.test/a*')).toBe(true);
    expect(R.urlMatches('https://h.test/a\\*', 'https://h.test/ab')).toBe(false);
  });
  it('query keys are order-insensitive and extra keys are allowed', () => {
    const p = 'https://h.test/s?b=2&a=1';
    expect(R.urlMatches(p, 'https://h.test/s?a=1&b=2')).toBe(true);
    expect(R.urlMatches(p, 'https://h.test/s?a=1&b=2&c=3')).toBe(true);
    expect(R.urlMatches(p, 'https://h.test/s?a=1')).toBe(false);
    expect(R.urlMatches('https://h.test/s?q=*', 'https://h.test/s?q=a%2Fb')).toBe(true);
  });
});

describe('rule set matching (D6)', () => {
  it('matches on method', () => {
    const s = set([{ id: 'p', method: 'POST', url: '**/track', status: 204 }, { id: 'g', url: '**/track', status: 200 }]);
    expect(s.match({ ...GET('https://h.test/track'), method: 'POST' }).rule.id).toBe('p');
    expect(s.match(GET('https://h.test/track')).rule.id).toBe('g');
    expect(set([{ id: 'm', method: ['GET', 'head'], url: '**', status: 200 }]).match({ ...GET('https://h.test/x'), method: 'HEAD' }).rule.id).toBe('m');
  });
  it('first match wins in declaration order', () => {
    const s = set([{ id: 'a', url: '**/x', status: 200 }, { id: 'b', url: '**/x', status: 201 }]);
    expect(s.match(GET('https://h.test/x')).rule.id).toBe('a');
  });
  it('run-time rules are prepended and override config fixtures; reset drops them', () => {
    const s = set([{ id: 'cfg', url: '**/x', status: 200 }]);
    s.add({ id: 'one', url: '**/x', status: 201 }, { scope: 't1' });
    s.add({ id: 'two', url: '**/x', status: 202 }, { scope: 't2' });
    expect(s.match(GET('https://h.test/x')).rule.id).toBe('two');
    s.reset({ scope: 't2' });
    expect(s.match(GET('https://h.test/x')).rule.id).toBe('one');
    s.reset();
    expect(s.match(GET('https://h.test/x')).rule.id).toBe('cfg');
    expect(s.configCount()).toBe(1);
  });
  it('times: 2 then falls through', () => {
    const s = set([{ id: 'a', url: '**/x', times: 2, status: 200 }, { id: 'b', url: '**/x', status: 500 }]);
    const ids = [1, 2, 3, 4].map(() => s.match(GET('https://h.test/x')).rule.id);
    expect(ids).toEqual(['a', 'a', 'b', 'b']);
    expect(set([{ url: '**/x', times: 1, status: 200 }]).match(GET('https://h.test/y'))).toBeNull();
  });
  it('sequence a, b, b, b advances per match only', () => {
    const s = set([{ id: 'q', url: '**/q', responses: [{ status: 503 }, { status: 200 }] }]);
    s.match(GET('https://h.test/other'));
    expect([1, 2, 3, 4].map(() => s.match(GET('https://h.test/q')).response.status)).toEqual([503, 200, 200, 200]);
  });
  it('header and body predicates', () => {
    const s = set([
      { id: 'h', url: '**', reqHeaders: { 'X-Mode': 'beta*' }, status: 201 },
      { id: 'b', url: '**', method: 'POST', reqBody: { json: { '$.user.id': 7 } }, status: 202 },
      { id: 'c', url: '**', method: 'POST', reqBody: 'play', status: 203 },
      { id: 'r', url: '**', method: 'POST', reqBody: { regex: '^\\d+$' }, status: 204 },
      { id: 'z', url: '**', status: 200 },
    ]);
    const post = (body) => ({ ...GET('https://h.test/x'), method: 'POST', body });
    expect(s.match(GET('https://h.test/x', { headers: { 'x-mode': 'beta2' } })).rule.id).toBe('h');
    expect(s.match(GET('https://h.test/x', { headers: { 'x-mode': 'alpha' } })).rule.id).toBe('z');
    expect(s.match(post('{"user":{"id":7}}')).rule.id).toBe('b');
    expect(s.match(post('{"user":{"id":8},"a":"play"}')).rule.id).toBe('c');
    expect(s.match(post('123')).rule.id).toBe('r');
    expect(s.match(post('nope')).rule.id).toBe('z');
  });
});

describe('fault and response normalization', () => {
  it('accepts fault shorthand, kind form and status faults', () => {
    const s = set([
      { id: 'a', url: '**/a', fault: 'timeout' },
      { id: 'b', url: '**/b', kind: 'reset' },
      { id: 'c', url: '**/c', kind: 'status', status: 502 },
      { id: 'd', url: '**/d', fault: { kind: 'status' } },
    ]);
    expect(s.match(GET('https://h.test/a')).response.fault.kind).toBe('timeout');
    expect(s.match(GET('https://h.test/b')).response.fault.kind).toBe('reset');
    expect(s.match(GET('https://h.test/c')).response.fault).toEqual({ kind: 'status', status: 502 });
    expect(s.match(GET('https://h.test/d')).response.fault.status).toBe(503);
  });
  it('rejects bad rules with clear errors', () => {
    const bad = (r) => () => set([r]);
    expect(bad({ status: 200 })).toThrow(/url/);
    expect(bad({ url: '**', fault: 'explode' })).toThrow(/fault kind/);
    expect(bad({ url: '**', body: 'a', json: {} })).toThrow(/only one/);
    expect(bad({ url: '**', times: 0 })).toThrow(/times/);
    expect(bad({ url: '**', status: 99 })).toThrow(/status/);
    expect(bad({ url: '**', responses: [] })).toThrow(/responses/);
    expect(bad({ url: '**', reqBody: { json: { 'a.b': 1 } } })).toThrow(/JSON path/);
  });
  it('file bodies are confined to the root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-rules-'));
    try {
      fs.writeFileSync(path.join(root, 'ok.json'), '{"a":1}');
      fs.writeFileSync(path.join(path.dirname(root), 'bt-outside.txt'), 'x');
      const s = set([{ id: 'ok', url: '**/ok', file: 'ok.json' }, { id: 'out', url: '**/out', file: '../bt-outside.txt' }, { id: 'no', url: '**/no', file: 'nope.json' }], root);
      expect(R.resolveBody(s.match(GET('https://h.test/ok')).response, root).toString()).toBe('{"a":1}');
      expect(() => R.resolveBody(s.match(GET('https://h.test/out')).response, root)).toThrow(/outside the project root/);
      expect(() => R.resolveBody(s.match(GET('https://h.test/no')).response, root)).toThrow(/not found/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(path.join(path.dirname(root), 'bt-outside.txt'), { force: true });
    }
  });
});

describe('redaction', () => {
  const red = R.makeRedactor({ jsonPaths: ['$.user.email', '$.items[*].pin'], query: ['otp'] });
  it('masks the documented headers deterministically', () => {
    const h = red.headers({ Authorization: 'Bearer abc', Cookie: 'a=b', 'Set-Cookie': 'c=d', 'X-Roku-Reserved-Dev-Id': '1', 'X-API-Key': 'k', 'x-session-id': 's', 'X-Thing-Token': 't', Accept: 'a/b' });
    expect(h.Authorization).toBe('<redacted:authorization>');
    for (const k of ['Cookie', 'Set-Cookie', 'X-Roku-Reserved-Dev-Id', 'X-API-Key', 'x-session-id', 'X-Thing-Token']) expect(h[k]).toMatch(/^<redacted:/);
    expect(h.Accept).toBe('a/b');
    expect(red.headers({ authorization: 'x' })).toEqual(red.headers({ authorization: 'y' }));
  });
  it('masks token, access_token, sig and configured query params, keeps order', () => {
    const u = red.url('https://h.test/p?a=1&token=abc&access_token=def&sig=ghi&otp=9&z=2#frag');
    expect(u).not.toMatch(/abc|def|ghi|=9/);
    expect(u.startsWith('https://h.test/p?a=1&token=')).toBe(true);
    expect(u.endsWith('&z=2#frag')).toBe(true);
  });
  it('masks JSON paths and form bodies; leaves other bodies alone', () => {
    const out = JSON.parse(red.body('{"user":{"email":"a@b.c","n":1},"items":[{"pin":"1"},{"pin":"2"}]}', 'application/json'));
    expect(out.user.email).toBe('<redacted:email>');
    expect(out.user.n).toBe(1);
    expect(out.items.map((i) => i.pin)).toEqual(['<redacted:pin>', '<redacted:pin>']);
    expect(red.body('token=abc&x=1', 'application/x-www-form-urlencoded')).not.toMatch(/abc/);
    expect(red.body('not json', 'text/plain')).toBe('not json');
    expect(red.body('{"user":{"x":1}}', 'application/json')).toBe('{"user":{"x":1}}');
  });
  it('disabled redaction passes through and warns once about Authorization', () => {
    const warns = [];
    const off = R.makeRedactor({ enabled: false, warn: (m) => warns.push(m) });
    expect(off.headers({ Authorization: 'Bearer x' }).Authorization).toBe('Bearer x');
    off.headers({ Authorization: 'Bearer y' });
    expect(warns).toHaveLength(1);
    expect(off.url('https://h.test/?token=abc')).toContain('abc');
  });
});

describe('redaction by body key name (opt-in bodyKeys)', () => {
  const json = (r, t, ct = 'application/json') => JSON.parse(r.body(t, ct));
  const keys = R.makeRedactor({ bodyKeys: ['token', 'Access_Token', 'password'] });
  it('masks nothing by name when bodyKeys is not set (empty default)', () => {
    const none = R.makeRedactor({});
    const t = '{"token":"dummy-1","password":"dummy-2","a":{"secret":"dummy-3"}}';
    expect(none.body(t, 'application/json')).toBe(t);
    expect(none.responseBody(t, 'application/json')).toBe(t);
    expect(R.makeRedactor({ jsonPaths: ['$.x'] }).body(t, 'application/json')).toBe(t);
  });
  it('masks root, nested and array keys with the existing placeholder', () => {
    const out = json(keys, '{"token":"d1","a":{"b":{"password":"d2"}},"list":[{"token":"d3"},{"n":1}],"keep":"v"}');
    expect(out.token).toBe('<redacted:token>');
    expect(out.a.b.password).toBe('<redacted:password>');
    expect(out.list[0].token).toBe('<redacted:token>');
    expect(out.list[1]).toEqual({ n: 1 });
    expect(out.keep).toBe('v');
  });
  it('replaces the whole value, even an object', () => {
    expect(json(keys, '{"token":{"a":1,"b":[2]}}').token).toBe('<redacted:token>');
  });
  it('matches case-insensitively and ignores _ and - in key and list', () => {
    const out = json(keys, '{"accessToken":"d1","ACCESS-TOKEN":"d2","access_token":"d3","Password":"d4","tokens":"keep"}');
    expect(out.accessToken).toBe('<redacted:accesstoken>');
    expect(out['ACCESS-TOKEN']).toBe('<redacted:access-token>');
    expect(out.access_token).toBe('<redacted:access_token>');
    expect(out.Password).toBe('<redacted:password>');
    expect(out.tokens).toBe('keep');
  });
  it('shares the walk for responses, including an echoed JSON string', () => {
    const echoed = JSON.parse(keys.responseBody(JSON.stringify({ json: { token: 'd1' }, data: '{"password":"d2","k":"v"}' }), 'application/json'));
    expect(echoed.json.token).toBe('<redacted:token>');
    expect(JSON.parse(echoed.data)).toEqual({ password: '<redacted:password>', k: 'v' });
  });
  it('runs after jsonPaths and combines with them', () => {
    const both = R.makeRedactor({ jsonPaths: ['$.user.email'], bodyKeys: ['token'] });
    const out = json(both, '{"user":{"email":"a@b.c"},"token":"d1","n":1}');
    expect(out).toEqual({ user: { email: '<redacted:email>' }, token: '<redacted:token>', n: 1 });
  });
  it('masks form fields named in bodyKeys as well as query names; leaves non-JSON alone', () => {
    const f = keys.body('password=dummy&access_token=d&x=1&token=t', 'application/x-www-form-urlencoded');
    expect(f).not.toMatch(/dummy|=d&|=t$/);
    expect(f).toContain('x=1');
    expect(R.makeRedactor({}).body('secret=abc&x=1', 'application/x-www-form-urlencoded')).toBe('secret=abc&x=1');
    expect(keys.body('token: plain', 'text/plain')).toBe('token: plain');
    expect(keys.body('{not json token', 'application/json')).toBe('{not json token');
  });
  it('enabled:false masks nothing', () => {
    const t = '{"token":"d1"}';
    expect(R.makeRedactor({ enabled: false, bodyKeys: ['token'] }).body(t, 'application/json')).toBe(t);
    expect(R.makeRedactor({ enabled: false, bodyKeys: ['token'] }).responseBody(t, 'application/json')).toBe(t);
  });
});

describe('bodyKeys scope, depth, BOM, base64 and validation', () => {
  const keys = R.makeRedactor({ bodyKeys: ['page', 'password', 'access_token'] });
  it('does not touch URL query parameters (url, queryString, HAR url/queryString, rules from HAR)', () => {
    const u = 'https://h.test/list?page=2&n=1';
    expect(keys.url(u)).toBe(u);
    expect(keys.queryString('page=2&n=1')).toBe('page=2&n=1');
    const mk = (u2) => ({ startedDateTime: 1, time: 1, method: 'GET', url: u2, reqHeaders: {}, reqBody: null, status: 200, resHeaders: { 'content-type': 'application/json' }, resBody: Buffer.from('{"ok":1}'), timings: {} });
    const withKeys = R.buildHar([mk(u)], { redact: { bodyKeys: ['page'] } });
    const without = R.buildHar([mk(u)], { redact: {} });
    expect(withKeys.log.entries[0].request.url).toBe(u);
    expect(withKeys.log.entries[0].request.queryString).toEqual([{ name: 'page', value: '2' }, { name: 'n', value: '1' }]);
    const har = R.buildHar([mk('https://h.test/list?page=1'), mk('https://h.test/list?page=2')], { redact: { bodyKeys: ['page'] } });
    const rules = R.rulesFromHar(har);
    expect(rules).toEqual(R.rulesFromHar(R.buildHar([mk('https://h.test/list?page=1'), mk('https://h.test/list?page=2')], { redact: {} })));
    expect(rules.length).toBe(2);
  });
  it('masks form field names after normalisation', () => {
    const f = keys.body('pass-word=dummy1&Access_Token=dummy2&n=1', 'application/x-www-form-urlencoded');
    expect(f).not.toMatch(/dummy/);
    expect(f).toContain('n=1');
  });
  const deep = (d, obj) => (obj ? '{"a":'.repeat(d) + '{"token":"d1"}' + '}'.repeat(d) : '['.repeat(d) + ']'.repeat(d));
  it('does not throw on 10,000 levels of nesting (array and object, jsonPaths and bodyKeys)', () => {
    for (const cfg of [{ jsonPaths: ['$.x'] }, { bodyKeys: ['token'] }]) {
      const r = R.makeRedactor(cfg);
      for (const t of [deep(10000, false), deep(10000, true)]) {
        for (const f of ['body', 'responseBody']) expect(() => r[f](t, 'application/json')).not.toThrow();
      }
    }
    const out = R.makeRedactor({ bodyKeys: ['token'] }).body(deep(10000, true), 'application/json');
    expect(out).not.toContain('d1');
    const e = { startedDateTime: 1, time: 1, method: 'POST', url: 'https://h.test/x', reqHeaders: { 'content-type': 'application/json' }, reqBody: Buffer.from(deep(10000, true)), status: 200, resHeaders: { 'content-type': 'application/json' }, resBody: Buffer.from(deep(10000, true)), timings: {} };
    const har = R.buildHar([e], { redact: { bodyKeys: ['token'], jsonPaths: ['$.x'] } });
    expect(JSON.stringify(har)).not.toContain('d1');
  });
  it('strips a leading BOM before parsing, also for JSON held in a string value', () => {
    const bom = '﻿';
    const r = R.makeRedactor({ bodyKeys: ['token'] });
    expect(r.body(`${bom}{"token":"d1","n":1}`, 'application/json')).not.toContain('d1');
    const wrapped = JSON.stringify({ echo: `${bom}{"token":"d2"}` });
    expect(r.responseBody(wrapped, 'application/json')).not.toContain('d2');
  });
  it('redacts a JSON response saved as base64 under a non-text content-type', () => {
    const e = { startedDateTime: 1, time: 1, method: 'GET', url: 'https://h.test/x', reqHeaders: {}, reqBody: null, status: 200, resHeaders: { 'content-type': 'application/octet-stream' }, resBody: Buffer.from('{"token":"d1","keep":"v"}'), timings: {} };
    const c = (redact) => R.buildHar([e], { redact }).log.entries[0].response.content;
    const on = c({ bodyKeys: ['token'] });
    expect(on.encoding).toBe('base64');
    const dec = Buffer.from(on.text, 'base64').toString();
    expect(dec).not.toContain('d1');
    expect(dec).toContain('keep');
    expect(Buffer.from(c({}).text, 'base64').toString()).toContain('d1');
    expect(Buffer.from(c({ jsonPaths: ['$.token'] }).text, 'base64').toString()).not.toContain('d1');
  });
  it('rejects a bad bodyKeys with a clear NetRuleError; empty array is off', () => {
    for (const bad of ['token', 5, 0, true, false, '', {}, { a: 1 }, [null], [1], ['ok', {}], null]) {
      expect(() => R.makeRedactor({ bodyKeys: bad }), JSON.stringify(bad)).toThrow(/redact\.bodyKeys must be an array of strings/);
      try { R.makeRedactor({ bodyKeys: bad }); } catch (e) { expect(e.name).toBe('NetRuleError'); }
    }
    const off = R.makeRedactor({ bodyKeys: [] });
    expect(off.body('{"token":"d1"}', 'application/json')).toBe('{"token":"d1"}');
  });
});

describe('HAR import/export', () => {
  const entries = [
    { startedDateTime: 1700000000000, time: 12, method: 'GET', url: 'https://h.test/auth?token=abc&n=1', reqHeaders: { Authorization: 'Bearer test-not-secret' }, reqBody: null, status: 200, resHeaders: { 'content-type': 'application/json', 'set-cookie': 'sid=zzz' }, resBody: Buffer.from('{"ok":true,"user":{"email":"a@b.c"}}'), timings: { blocked: 0, wait: 10, receive: 2 } },
    { startedDateTime: 1700000001000, time: 3, method: 'GET', url: 'https://h.test/auth?token=abc&n=1', reqHeaders: {}, reqBody: null, status: 503, resHeaders: {}, resBody: Buffer.from('busy'), timings: { wait: 1 } },
    { startedDateTime: 1700000002000, time: 3, method: 'POST', url: 'https://h.test/track', reqHeaders: { 'content-type': 'application/json' }, reqBody: Buffer.from('{"user":{"email":"x@y.z"}}'), status: 204, resHeaders: {}, resBody: Buffer.alloc(0), timings: {} },
    { startedDateTime: 1700000003000, time: 3, method: 'GET', url: 'https://h.test/bin', reqHeaders: {}, reqBody: null, status: 200, resHeaders: { 'content-type': 'image/png' }, resBody: Buffer.from([0, 1, 2, 255]), timings: {} },
  ];
  const har = R.buildHar(entries, { redact: { jsonPaths: ['$.user.email'] } });
  it('exports a valid HAR 1.2 with secrets redacted', () => {
    expect(R.validateHar(har)).toEqual([]);
    const text = JSON.stringify(har);
    expect(text).not.toMatch(/test-not-secret|abc|zzz|a@b\.c|x@y\.z/);
    expect(har.log.entries[0].request.queryString.map((q) => q.name)).toEqual(['token', 'n']);
    expect(har.log.entries[3].response.content.encoding).toBe('base64');
  });
  it('redacts response bodies by JSON path (root, nested, echoed string) and leaves non-JSON alone', () => {
    const red = R.makeRedactor({ jsonPaths: ['$.user.email'] });
    expect(red.responseBody('{"user":{"email":"REDACTED-TEST-VALUE","n":1}}', 'application/json')).toBe('{"user":{"email":"<redacted:email>","n":1}}');
    expect(red.responseBody('{"json":{"user":{"email":"REDACTED-TEST-VALUE"}}}', 'application/json')).toBe('{"json":{"user":{"email":"<redacted:email>"}}}');
    const echoed = JSON.parse(red.responseBody(JSON.stringify({ body: '{"user":{"email":"REDACTED-TEST-VALUE","k":"v"}}' }), 'application/json'));
    expect(JSON.parse(echoed.body)).toEqual({ user: { email: '<redacted:email>', k: 'v' } });
    expect(red.responseBody('{"other":"REDACTED-TEST-VALUE"}', 'application/json')).toBe('{"other":"REDACTED-TEST-VALUE"}');
    expect(red.responseBody('plain REDACTED-TEST-VALUE text', 'text/plain')).toBe('plain REDACTED-TEST-VALUE text');
    expect(red.body('{"json":{"user":{"email":"x"}}}', 'application/json')).toBe('{"json":{"user":{"email":"x"}}}');
    expect(R.makeRedactor({ enabled: false, jsonPaths: ['$.user.email'] }).responseBody('{"user":{"email":"x"}}')).toBe('{"user":{"email":"x"}}');
  });
  it('validateHar reports problems', () => {
    expect(R.validateHar({}).length).toBeGreaterThan(0);
    expect(() => R.rulesFromHar({ log: { version: '1.2' } })).toThrow(/not a valid HAR/);
  });
  it('round trip: replay matches the real secret, repeated requests become a sequence', () => {
    const rules = R.rulesFromHar(JSON.parse(JSON.stringify(har)));
    expect(rules).toHaveLength(3);
    const s = set(rules);
    const a = s.match(GET('https://h.test/auth?n=1&token=REAL'));
    expect(a.response.status).toBe(200);
    expect(s.match(GET('https://h.test/auth?n=1&token=REAL')).response.status).toBe(503);
    expect(s.match(GET('https://h.test/auth?n=1&token=REAL')).response.status).toBe(503);
    expect(s.match(GET('https://h.test/auth?n=2&token=REAL'))).toBeNull();
    expect(s.match({ ...GET('https://h.test/track'), method: 'POST' }).response.status).toBe(204);
    const bin = s.match(GET('https://h.test/bin')).response;
    expect(R.resolveBody(bin).equals(Buffer.from([0, 1, 2, 255]))).toBe(true);
  });
  it('loads HAR and JSON rule files by content', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-har-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.har'), JSON.stringify(har));
      fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ rules: [{ url: '**/x', status: 200 }] }));
      fs.writeFileSync(path.join(dir, 'c.json'), '{}');
      expect(R.loadRulesFile(path.join(dir, 'a.har'))).toHaveLength(3);
      expect(R.loadRulesFile(path.join(dir, 'b.json'))).toHaveLength(1);
      expect(() => R.loadRulesFile(path.join(dir, 'c.json'))).toThrow(/array of rules/);
      expect(() => R.loadRulesFile(path.join(dir, 'missing.json'))).toThrow(/cannot read/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
