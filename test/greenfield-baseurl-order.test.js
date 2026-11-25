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

describe('greenfield sample: BT_BASE_URL reaches HttpTask and is validated', () => {
  const config = read('source', 'lib', 'Config.brs');

  // Evaluate Config_baseUrl's decision rule as written in the .brs (http/https only, else default).
  function baseUrl(args) {
    const fn = /function Config_baseUrl[\s\S]*?end function/.exec(config)[0];
    expect(fn).toMatch(/type\(args\.BT_BASE_URL\) = "roString"/);
    expect(fn).toMatch(/left\(lCase\(v\), 7\) = "http:\/\/" or left\(lCase\(v\), 8\) = "https:\/\/"/);
    const def = /Config_defaultBaseUrl\(\) as string\n\s+return "([^"]+)"/.exec(config)[1];
    const v = args && args.BT_BASE_URL;
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v;
    return def;
  }

  it('honours an http URL and ignores anything else; default unchanged', () => {
    expect(baseUrl({ BT_BASE_URL: 'http://192.168.2.5:9000' })).toBe('http://192.168.2.5:9000');
    expect(baseUrl({})).toBe('http://127.0.0.1:8787');
    expect(baseUrl({ BT_BASE_URL: 'ftp://x' })).toBe('http://127.0.0.1:8787');
    expect(baseUrl({ BT_BASE_URL: '' })).toBe('http://127.0.0.1:8787');
  });

  it('the value flows Main() -> MainScene.baseUrl -> HttpTask.baseUrl -> request URL', () => {
    expect(read('source', 'main.brs')).toMatch(/scene\.baseUrl = Config_baseUrl\(args\)/);
    expect(read('components', 'screens', 'MainScene.brs')).toMatch(/task\.baseUrl = m\.top\.baseUrl/);
    expect(read('components', 'net', 'HttpTask.brs')).toMatch(/Http_join\(m\.top\.baseUrl, req\.path\)/);
  });
});
