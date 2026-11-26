import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { profilingDir, listTraceFiles, resolveTraceFile } = require('../lib/studio/perfetto.js');

describe('trace file helpers', () => {
  let root, dir;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-trace-files-'));
    dir = profilingDir(root);
    fs.mkdirSync(dir, { recursive: true });
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const put = (name, body = 'x') => fs.writeFileSync(path.join(dir, name), body);

  it('profilingDir is under .brighttest/studio/profiling', () => {
    expect(dir).toBe(path.join(root, '.brighttest', 'studio', 'profiling'));
  });

  it('listTraceFiles: newest name first, only trace files, with bytes and mtime', () => {
    put('trace-2026-01-01T00-00-00-000Z.perfetto-trace', 'aa');
    put('trace-2026-02-01T00-00-00-000Z.perfetto-trace', 'bbbb');
    put('notes.txt');
    const l = listTraceFiles(dir);
    expect(l.map((f) => f.name)).toEqual(['trace-2026-02-01T00-00-00-000Z.perfetto-trace', 'trace-2026-01-01T00-00-00-000Z.perfetto-trace']);
    expect(l[0].bytes).toBe(4);
    expect(typeof l[0].mtime).toBe('number');
  });

  it('listTraceFiles: missing dir is empty', () => {
    expect(listTraceFiles(path.join(root, 'nope'))).toEqual([]);
  });

  it('resolveTraceFile returns the real path of a plain trace name', () => {
    put('a.perfetto-trace');
    expect(resolveTraceFile(dir, 'a.perfetto-trace')).toBe(fs.realpathSync(path.join(dir, 'a.perfetto-trace')));
  });

  it.each([
    ['empty', ''],
    ['parent traversal', '../a.perfetto-trace'],
    ['nested', 'sub/a.perfetto-trace'],
    ['absolute', '/etc/passwd.perfetto-trace'],
    ['NUL', 'a\0.perfetto-trace'],
    ['wrong suffix', 'a.txt'],
  ])('refuses %s with EPATH', (_n, name) => {
    expect(() => resolveTraceFile(dir, name)).toThrow(expect.objectContaining({ code: 'EPATH' }));
  });

  it('refuses a symlink pointing outside the folder', () => {
    const outside = path.join(root, 'outside.perfetto-trace');
    fs.writeFileSync(outside, 'x');
    fs.symlinkSync(outside, path.join(dir, 'link.perfetto-trace'));
    expect(() => resolveTraceFile(dir, 'link.perfetto-trace')).toThrow(expect.objectContaining({ code: 'EPATH' }));
  });

  it('a missing file throws ENOENT carrying the lexical path', () => {
    try { resolveTraceFile(dir, 'gone.perfetto-trace'); throw new Error('no throw'); }
    catch (e) { expect(e.code).toBe('ENOENT'); expect(e.path).toBe(path.join(path.resolve(dir), 'gone.perfetto-trace')); }
  });
});
