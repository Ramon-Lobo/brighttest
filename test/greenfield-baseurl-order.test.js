import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'examples', 'greenfield-app');
const read = (...p) => fs.readFileSync(path.join(APP, ...p), 'utf8').replace(/\r\n/g, '\n');

// Extract the body of `sub <name>(...)` ... `end sub`.
function subBody(src, name) {
  const m = new RegExp(`^sub ${name}\\([^)]*\\)\\n([\\s\\S]*?)^end sub`, 'm').exec(src);
  return m ? m[1] : null;
}

describe('greenfield sample: BT_BASE_URL is applied before the first request', () => {
  const scene = read('components', 'screens', 'MainScene.brs');
  const main = read('source', 'main.brs');

  it('MainScene init() does not start a request (baseUrl is still the default there)', () => {
    expect(subBody(scene, 'init')).not.toMatch(/\brequest\(/);
  });

  it('Main() sets scene.baseUrl from BT_BASE_URL before the scene is released to start requests', () => {
    const base = main.indexOf('scene.baseUrl = Config_baseUrl(args)');
    const ready = main.indexOf('scene.ready = true');
    expect(base).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(base);
  });

  it('the first (hero GET /home) request runs from the ready handler and copies m.top.baseUrl', () => {
    expect(subBody(scene, 'onReady')).toMatch(/request\("hero", \{ mode: "getAsync", path: "\/home" \}\)/);
    expect(subBody(scene, 'request')).toMatch(/task\.baseUrl = m\.top\.baseUrl/);
    expect(read('components', 'screens', 'MainScene.xml')).toMatch(/id="ready"[^>]*onChange="onReady"/);
  });
});
