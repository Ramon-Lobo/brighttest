import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { check, generateManifest } = require('../lib/skills')

const sink = () => ({ buf: '', write(s) { this.buf += s; } })
let root
const put = (rel, body = '# x\n') => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
}
const writeManifest = () => fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(generateManifest(root), null, 2) + '\n')

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-skills-check-'));
  put('alpha/SKILL.md');
  put('alpha/references/a.md');
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('skills --check (AGT-03)', () => {
  test('identical manifest exits 0 and writes nothing', () => {
    writeManifest();
    const before = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');
    const out = sink(), err = sink();
    expect(check(root, out, err)).toBe(0);
    expect(out.buf).toMatch(/up to date/);
    expect(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).toBe(before);
  })

  test('drift exits non-zero and names the file', () => {
    writeManifest();
    put('alpha/references/new.md');
    const err = sink();
    expect(check(root, sink(), err)).toBe(1);
    expect(err.buf).toContain('alpha/references/new.md');
    expect(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).not.toContain('new.md');
  })

  test('stale manifest entry is named', () => {
    writeManifest();
    fs.rmSync(path.join(root, 'alpha/references/a.md'));
    const err = sink();
    expect(check(root, sink(), err)).toBe(1);
    expect(err.buf).toContain('alpha/references/a.md');
  })

  test('missing committed manifest exits non-zero with a clear message', () => {
    const err = sink();
    expect(check(root, sink(), err)).toBe(1);
    expect(err.buf).toMatch(/manifest\.json is missing/);
  })

  test('the committed repo manifest is in sync', () => {
    expect(check(path.join(__dirname, '..', 'skills'), sink(), sink())).toBe(0);
  })
})
