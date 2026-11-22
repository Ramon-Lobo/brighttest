import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { findTaskComponents, warnTaskUsage } = require('../lib/task-detect.js');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-task-')); fs.mkdirSync(path.join(dir, 'components'), { recursive: true }); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const comp = (name, ext) => fs.writeFileSync(path.join(dir, 'components', name), `<?xml version="1.0"?>\n<component name="X" extends="${ext}"></component>\n`);

describe('Task detection (-n lane)', () => {
  it('warns once per Task component, naming the file and the device lane', () => {
    comp('Fetch.xml', 'Task');
    const lines = [];
    expect(warnTaskUsage(dir, (l) => lines.push(l))).toEqual(['components/Fetch.xml']);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('components/Fetch.xml');
    expect(lines[0]).toMatch(/headless lane/);
    expect(lines[0]).toMatch(/--device/);
  });

  it('emits nothing for apps without Task', () => {
    comp('Card.xml', 'Group');
    const lines = [];
    expect(warnTaskUsage(dir, (l) => lines.push(l))).toEqual([]);
    expect(lines).toEqual([]);
    expect(findTaskComponents(dir)).toEqual([]);
  });

  it('is only wired into the -n lane (lib/headless.js runSuite), not the device lane', () => {
    const root = path.join(__dirname, '..', 'lib');
    expect(fs.readFileSync(path.join(root, 'headless.js'), 'utf8')).toContain("require('./task-detect')");
    expect(fs.readFileSync(path.join(root, 'device.js'), 'utf8')).not.toContain('task-detect');
  });
});
