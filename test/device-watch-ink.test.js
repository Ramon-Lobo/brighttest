import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import W from '../lib/device-watch.js';
import T from '../lib/tui.js';
import { loadInk } from '../lib/tui-ink.js';
import A from '../lib/device-watch-ink.js';
import { NOW, makeBoard } from './support/watch-board.js';

// The live screen drawn with ink. ink and react are optional dependencies: the tests that need them are skipped
// when they are not installed (npm i --omit=optional), the loader and fallback tests always run.
// Color level is forced before ink is imported so renderToString emits truecolor SGR.
process.env.FORCE_COLOR = '3';

const GOLD = (name) => path.join(import.meta.dirname, 'fixtures', 'device-watch-ink', name);
const ROOT = path.resolve(import.meta.dirname, '..');
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
let mods = null;
beforeAll(async () => { const r = await loadInk(); mods = r.error ? null : r; });
const have = () => !!mods;

function viewOut(level, cols, rows, uiOver = {}) {
  const { ink, React } = mods;
  const View = A.createWatchView({ ink, React, level });
  const b = makeBoard();
  const ui = { ...W.initialUi({ cols, rows }, {}, b), ...uiOver };
  const model = W.renderModel(b, ui, { cols, rows }, NOW, { level, utc: true });
  return ink.renderToString(React.createElement(View, { model, ui, size: { cols, rows } }), { columns: cols });
}

describe('renderToString layout goldens (ANSI stripped)', () => {
  for (const [cols, rows] of [[80, 24], [120, 30]]) {
    for (const [name, over] of [['list', {}], ['detail', { focus: 'detail', detailOpen: true, runCursor: 1 }], ['help', { help: true }]]) {
      it(`${name} ${cols}x${rows}`, async (ctx) => {
        if (!have()) return ctx.skip();
        await expect(strip(viewOut('none', cols, rows, over)) + '\n').toMatchFileSnapshot(GOLD(`${name}-${cols}x${rows}.txt`));
      });
    }
  }
  it('too small', async (ctx) => {
    if (!have()) return ctx.skip();
    expect(strip(viewOut('none', 50, 10))).toContain('terminal too small (need 60x16)');
  });
  it('a hostile purpose never reaches the output as an escape', (ctx) => {
    if (!have()) return ctx.skip();
    const { ink, React } = mods;
    const b = makeBoard();
    b.devices[0].holder.purpose = 'x \x1b]0;pwned\x07 y';
    const ui = W.initialUi({ cols: 120, rows: 30 }, {}, b);
    const View = A.createWatchView({ ink, React, level: 'none' });
    const model = W.renderModel(b, ui, { cols: 120, rows: 30 }, NOW, { level: 'none', utc: true });
    const out = ink.renderToString(React.createElement(View, { model, ui, size: { cols: 120, rows: 30 } }), { columns: 120 });
    expect(out).not.toMatch(/\x1b\]/);
    expect(out).not.toContain('pwned\x07');
  });
});

describe('truecolor SGR equals the tokens in lib/tui.js', () => {
  it('foreground and background values appear for violet, panel, panel2 and ink', (ctx) => {
    if (!have()) return ctx.skip();
    const out = viewOut('truecolor', 120, 30);
    const rgb = (tok) => T.hexToRgb(T.TOKENS[tok]).join(';');
    expect(out).toContain(`38;2;${rgb('violet')}`);
    expect(out).toContain(`48;2;${rgb('panel')}`);
    expect(out).toContain(`48;2;${rgb('panel2')}`);
    expect(out).toContain(`48;2;${rgb('ink')}`);
    expect(out).toContain(`38;2;${rgb('amber')}`);
  });
  it('the 16-color level paints no backgrounds', (ctx) => {
    if (!have()) return ctx.skip();
    expect(viewOut('16', 120, 30)).not.toMatch(/\x1b\[[0-9;]*(48;|4[0-7]m|10[0-7]m)/);
  });
});

// ---- the mount against fake terminal streams ---------------------------------------------------
function fakeTerm() {
  const writes = [];
  const stdout = new Writable({ write(chunk, enc, cb) { writes.push(String(chunk)); cb(); } });
  Object.assign(stdout, { isTTY: true, columns: 100, rows: 30, getColorDepth: () => 24, hasColors: () => true, getWindowSize: () => [100, 30] });
  const raw = [];
  const stdin = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode: (v) => { raw.push(v); return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
  const err = [];
  const stderr = { write: (s) => { err.push(String(s)); return true; } };
  const proc = new EventEmitter();
  return { stdout, stdin, stderr, proc, writes, raw, err, out: () => writes.join('') };
}
const mkView = (over = {}) => { const v = { closed: 0, snapshot: () => makeBoard(), close() { v.closed++; }, ...over }; return v; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function mount(t, view, flags = {}) {
  const p = A.mountWatchApp({ ink: mods.ink, React: mods.React, view, flags: { intervalMs: 5000, ...flags }, proc: t.proc,
    io: { stdout: t.stdout, stdin: t.stdin, stderr: t.stderr, env: { COLORTERM: 'truecolor' }, now: () => NOW } });
  await sleep(150);
  return { p };
}
const assertRestored = (t) => {
  const o = t.out();
  expect(o).toContain('\x1b[?1049h');
  expect(o.lastIndexOf('\x1b[?1049l')).toBeGreaterThan(o.indexOf('\x1b[?1049h'));
  expect(o).toContain('\x1b[?25l');
  expect(o.lastIndexOf('\x1b[?25h')).toBeGreaterThan(o.lastIndexOf('\x1b[?25l'));
  expect(t.raw[0]).toBe(true);
  expect(t.raw[t.raw.length - 1]).toBe(false);
};

describe('mountWatchApp on fake streams', () => {
  for (const [name, keys] of [['q', 'q'], ['Ctrl-C', '\x03']]) {
    it(`${name} quits with 0 and restores the terminal`, async (ctx) => {
      if (!have()) return ctx.skip();
      const t = fakeTerm(); const v = mkView();
      const { p } = await mount(t, v);
      expect(t.out()).toContain('device watch');
      t.stdin.write(keys);
      expect(await p).toBe(0);
      assertRestored(t);
      expect(v.closed).toBe(1);
      expect(t.proc.listenerCount('SIGTERM')).toBe(0);
    });
  }
  it('Esc quits from the device list', async (ctx) => {
    if (!have()) return ctx.skip();
    const t = fakeTerm(); const { p } = await mount(t, mkView());
    t.stdin.write('\x1b');
    expect(await Promise.race([p, sleep(3000).then(() => 'timeout')])).toBe(0);
    assertRestored(t);
  });
  it('keys move the selection and ? opens the help overlay', async (ctx) => {
    if (!have()) return ctx.skip();
    const t = fakeTerm(); const { p } = await mount(t, mkView());
    t.stdin.write('j'); await sleep(80);
    t.stdin.write('?'); await sleep(80);
    expect(strip(t.out())).toContain('move selection');
    t.stdin.write('q'); // closes help first (any key), then q quits
    await sleep(50); t.stdin.write('q');
    expect(await p).toBe(0);
  });
  it('a render error restores the terminal, prints the error and returns 1', async (ctx) => {
    if (!have()) return ctx.skip();
    const t = fakeTerm(); const v = mkView({ snapshot: () => { throw new Error('boom'); } });
    const code = await (await mount(t, v)).p;
    expect(code).toBe(1);
    expect(t.err.join('')).toContain('boom');
    expect(v.closed).toBe(1);
    expect(t.raw.every((x) => x === false) || t.raw[t.raw.length - 1] === false).toBe(true);
    expect(t.out()).not.toContain('\x1b[?1049h\x1b[?1049h');
  });
  it('SIGTERM unmounts, restores the terminal and returns 143', async (ctx) => {
    if (!have()) return ctx.skip();
    const t = fakeTerm(); const v = mkView(); const { p } = await mount(t, v);
    t.proc.emit('SIGTERM');
    expect(await p).toBe(143);
    assertRestored(t);
    expect(v.closed).toBe(1);
  });
  it('SIGHUP returns 129 and an uncaught exception returns 1 with the error on stderr', async (ctx) => {
    if (!have()) return ctx.skip();
    let t = fakeTerm(); let { p } = await mount(t, mkView());
    t.proc.emit('SIGHUP');
    expect(await p).toBe(129);
    t = fakeTerm(); ({ p } = await mount(t, mkView()));
    t.proc.emit('uncaughtException', new Error('late failure'));
    expect(await p).toBe(1);
    expect(t.err.join('')).toContain('late failure');
    assertRestored(t);
  });
});

// ---- the loader and the fallback ---------------------------------------------------------------
describe('loadInk', () => {
  it('returns { error } when the importer throws', async () => {
    const r = await loadInk({ importer: async () => { throw Object.assign(new Error('Cannot find package ink'), { code: 'ERR_MODULE_NOT_FOUND' }); } });
    expect(r.error.message).toContain('ink');
    expect(r.ink).toBeUndefined();
  });
  it('returns { error } for a module without render (an old or wrong version)', async () => {
    const r = await loadInk({ importer: async (m) => (m === 'ink' ? { Box: {}, Text: {} } : { default: { createElement() {} } }) });
    expect(r.error).toBeInstanceOf(Error);
  });
  it('returns the modules when both load (react taken from its default export)', async () => {
    const ink = { render() {}, Box: {}, Text: {} }; const React = { createElement() {} };
    const names = [];
    const r = await loadInk({ importer: async (m) => { names.push(m); return m === 'ink' ? ink : { default: React }; } });
    expect(r.ink).toBe(ink); expect(r.React).toBe(React); expect(names).toEqual(['ink', 'react']);
  });
});

describe('runWatch mode and import rules', () => {
  const fakeIo = (extra = {}) => { const out = []; const err = []; let loads = 0; return { out, err, loads: () => loads,
    io: { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, stdoutIsTTY: false, stdinIsTTY: false, env: {}, platform: 'linux',
      now: () => NOW, loadInk: async () => { loads++; return { error: new Error('x') }; }, ...extra } }; };
  const view = () => ({ snapshot: () => makeBoard(), close() {} });
  const tty = { stdoutIsTTY: true, stdinIsTTY: true };

  it('a failing loader prints the one-line hint and runs the plain loop with exit 0', async () => {
    const f = fakeIo(tty); const ac = new AbortController();
    f.io.sleep = async () => ac.abort();
    expect(await W.runWatch({ view: view(), flags: {}, io: f.io, signal: ac.signal })).toBe(0);
    expect(f.loads()).toBe(1);
    expect(f.err).toEqual([W.INK_HINT + '\n']);
    expect(f.err[0]).toContain('npm i ink react');
    expect(f.out).toHaveLength(1);
    expect(f.out[0]).toContain('DEVICE');
  });
  it('the importer failing inside the real loader gives the same fallback', async () => {
    const f = fakeIo({ ...tty, loadInk: () => loadInk({ importer: async () => { throw new Error('nope'); } }) }); const ac = new AbortController();
    f.io.sleep = async () => ac.abort();
    expect(await W.runWatch({ view: view(), flags: {}, io: f.io, signal: ac.signal })).toBe(0);
    expect(f.err).toHaveLength(1);
  });
  for (const [name, flags, extra] of [['--plain', { plain: true }, tty], ['--once', { once: true, utc: true }, tty], ['--json', { json: true }, tty],
    ['a non-TTY', {}, {}], ['TERM=dumb', {}, { ...tty, env: { TERM: 'dumb' } }]]) {
    it(`never loads ink for ${name}`, async () => {
      const f = fakeIo(extra); const ac = new AbortController();
      f.io.sleep = async () => ac.abort();
      expect(await W.runWatch({ view: view(), flags, io: f.io, signal: ac.signal })).toBe(0);
      expect(f.loads()).toBe(0);
      expect(f.err).toEqual([]);
    });
  }
});

describe('only lib/tui-ink.js imports ink', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'web' ? [] : walk(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
  const IMPORTS = [/\brequire\s*\(\s*['"](?:ink|react)(?:\/[^'"]*)?['"]/, /\bimport\s*\(\s*['"](?:ink|react)['"]/, /\bfrom\s+['"](?:ink|react)(?:\/[^'"]*)?['"]/, /\bimporter\s*\(\s*['"](?:ink|react)['"]/];
  it('no other file under bin/ and lib/ names ink or react as a module', () => {
    const files = [...walk(path.join(ROOT, 'lib')), path.join(ROOT, 'bin', 'cli.js')];
    const offenders = files.filter((f) => !f.endsWith(path.join('lib', 'tui-ink.js'))).filter((f) => { const s = fs.readFileSync(f, 'utf8'); return IMPORTS.some((re) => re.test(s)); });
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
    expect(IMPORTS.some((re) => re.test(fs.readFileSync(path.join(ROOT, 'lib', 'tui-ink.js'), 'utf8')))).toBe(true);
  });
  it('ink and react are optionalDependencies, not dependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.optionalDependencies.ink).toBeTruthy();
    expect(pkg.optionalDependencies.react).toBeTruthy();
    expect(pkg.dependencies.ink).toBeUndefined();
    expect(pkg.dependencies.react).toBeUndefined();
  });
});
