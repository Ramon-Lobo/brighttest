import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
process.env.BRIGHTTEST_CACHE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-steps-cache-')), 'devices.json');
const studio = require('../lib/studio/server.js');
const { STEP_CATALOG } = require('../lib/e2e/step-catalog.js');

let server, port, root;
const get = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  }).on('error', reject);
});

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-steps-'));
  server = await studio.start({ port: 0, rootDir: root });
  port = server.address().port;
});
afterAll(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe('GET /api/steps', () => {
  it('serves the whole step catalog', async () => {
    const r = await get('/api/steps');
    expect(r.status).toBe(200);
    const { steps } = JSON.parse(r.body);
    expect(steps.length).toBe(STEP_CATALOG.length);
    expect(steps.length).toBe(33);
    const set = steps.find((s) => s.key === 'setState');
    expect(set.enums.layer).toContain('node');
    expect(set.snippet).toMatch(/^setState:/);
  });
});

// Drive the CodeMirror completion source with a fake context.
const fakeCtx = (text, explicit = false) => ({
  pos: text.length, explicit,
  state: { doc: { lineAt: () => ({ text, from: 0 }) } },
});

describe('flow editor completions from the catalog', () => {
  let C;
  beforeAll(async () => {
    C = await import('../lib/studio/web/src/lib/completions.js');
    C.setSteps(JSON.parse(JSON.stringify(STEP_CATALOG)));
  });

  it('offers every step including setState, with the catalog snippet', () => {
    const r = C.flowCompletions(() => null)(fakeCtx('  - set'));
    expect(r.options.length).toBe(33);
    const o = r.options.find((x) => x.label === 'setState');
    expect(o.apply).toBe('setState: { layer: global, path: , value:  }');
  });

  it('fills selected-node placeholders', () => {
    const r = C.flowCompletions(() => ({ id: 'title', text: 'Home' }))(fakeCtx('  - '));
    expect(r.options.find((x) => x.label === 'assertText').apply).toBe('assertText: { id: title, equals: "Home" }');
    expect(r.options.find((x) => x.label === 'assertVisible').boost).toBe(2);
  });

  it('offers a step\'s own keys inside its map', () => {
    const r = C.flowCompletions(() => null)(fakeCtx('  - setState: { '));
    const labels = r.options.map((x) => x.label);
    expect(labels).toEqual(expect.arrayContaining(['layer', 'path', 'value', 'ack']));
    expect(labels).not.toContain('subtype');
  });

  it('offers the layer enum values after layer:', () => {
    const r = C.flowCompletions(() => null)(fakeCtx('  - setState: { layer: '));
    expect(r.options.map((x) => x.label)).toEqual(['global', 'scene', 'node', 'm', 'registry']);
  });

  it('offers selector keys inside a nested selector map', () => {
    const r = C.flowCompletions(() => null)(fakeCtx('  - pressUntil: { key: Down, visible: { '));
    expect(r.options.map((x) => x.label)).toContain('textContains');
  });
});
