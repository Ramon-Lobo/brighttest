import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import issue from '../lib/issue.js';

describe('issue check / redact given a directory', () => {
  it('prints a clear message and exits 2 (usage), not a bare EISDIR', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-issue-dir-'));
    try {
      for (const sub of ['check', 'redact']) {
        let err = '';
        const code = issue.run([sub, dir], { out() {}, err: (s) => { err += s; }, cwd: () => dir, env: {} });
        expect(code).toBe(2);
        expect(err).toContain(`${dir} is a directory`);
        expect(err).not.toContain('EISDIR');
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
