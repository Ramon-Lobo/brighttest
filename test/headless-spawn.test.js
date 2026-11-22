import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnCapture, rootedRunArgs } = require('../lib/headless.js');

describe('headless spawnCapture (async stand-in for spawnSync)', () => {
  it('captures stdout, stderr and the exit status', async () => {
    const r = await spawnCapture(process.execPath, ['-e', 'console.log("out"); console.error("err"); process.exit(3)']);
    expect(r.stdout).toBe('out\n');
    expect(r.stderr).toBe('err\n');
    expect(r.status).toBe(3);
    expect(r.error).toBeUndefined();
  });

  it('kills on timeout and reports ETIMEDOUT with SIGKILL like spawnSync', async () => {
    const r = await spawnCapture(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 200 });
    expect(r.error && r.error.code).toBe('ETIMEDOUT');
    expect(r.signal).toBe('SIGKILL');
  });

  it('does not block the event loop while the child runs', async () => {
    let ticks = 0;
    const t = setInterval(() => { ticks++; }, 20);
    await spawnCapture(process.execPath, ['-e', 'setTimeout(()=>{},400)']);
    clearInterval(t);
    expect(ticks).toBeGreaterThan(5);
  });

  it('reports a spawn error', async () => {
    const r = await spawnCapture('/nonexistent/bt-bin', []);
    expect(r.error && r.error.code).toBe('ENOENT');
  });
});

describe('headless rootedRunArgs (package root on every lane)', () => {
  it('passes -r, root-relative files and a driver copy in the root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-root-'));
    try {
      fs.mkdirSync(path.join(root, 'source'));
      const args = rootedRunArgs(root, [path.join(root, 'source', 'a.brs')]);
      expect(args).toEqual(['-r', root, path.join('source', 'a.brs'), '__bt_driver.brs']);
      expect(fs.existsSync(path.join(root, '__bt_driver.brs'))).toBe(true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
