import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const R = require('../lib/instrument/net-rules.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'examples', 'greenfield-app', 'fixtures', 'net', 'home.rules.json');

describe('greenfield net rules fixture', () => {
  const set = R.createRuleSet({ root: ROOT });
  // addConfig runs the real validator; the old {match, respond} shape throws NetRuleError here.
  set.addConfig(R.loadRulesFile(FILE), { source: 'fixture' });
  const hit = (method, p) => set.match({ method, url: `http://127.0.0.1:8787${p}`, headers: {}, body: '' });

  it('loads three rules', () => { expect(set.configCount()).toBe(3); });
  it('GET /home returns 200 with a mocked title', () => {
    const m = hit('GET', '/home');
    expect(m.response.status).toBe(200);
    expect(m.response.json).toEqual({ title: 'Mocked hero' });
  });
  it('POST /track returns 204', () => { expect(hit('POST', '/track').response.status).toBe(204); });
  it('GET /search returns 503', () => { expect(hit('GET', '/search').response.status).toBe(503); });
  it('does not match other methods or paths', () => {
    expect(hit('POST', '/home')).toBeNull();
    expect(hit('GET', '/other')).toBeNull();
  });
});
