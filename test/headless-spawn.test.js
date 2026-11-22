import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import nodePath from 'path';
const __dirname_ = nodePath.dirname(fileURLToPath(import.meta.url));

const require = createRequire(import.meta.url);
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnCapture, rootedRunArgs, forceSplashZero } = require('../lib/headless.js');

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

describe('headless staged manifest splash_min_time', () => {
  const mk = (content) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-mf-'));
    if (content !== null) fs.writeFileSync(path.join(root, 'manifest'), content);
    return root;
  };
  const read = (root) => fs.readFileSync(path.join(root, 'manifest'), 'utf8');
  it('overrides an existing value, keeping other keys (rootedRunArgs, shared by the deviceInfo path)', () => {
    const root = mk('title=App\nsplash_min_time=4000\nbs_const=X=true\n');
    try {
      rootedRunArgs(root, []);
      expect(read(root)).toMatch(/^splash_min_time=0$/m);
      expect(read(root)).not.toContain('4000');
      expect(read(root)).toContain('title=App');
      expect(read(root)).toContain('bs_const=X=true');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('appends the key when absent, or creates the manifest when missing', () => {
    const a = mk('title=App');
    const b = mk(null);
    try {
      forceSplashZero(a); forceSplashZero(b);
      expect(read(a)).toBe('title=App\nsplash_min_time=0\n');
      expect(read(b)).toBe('splash_min_time=0\n');
    } finally { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); }
  });
  it('engine-run sets splash_min_time=0 on the payload manifest', () => {
    expect(fs.readFileSync(nodePath.join(__dirname_, '..', 'lib', 'engine-run.js'), 'utf8')).toContain("manifest.set('splash_min_time', '0')");
  });
});
