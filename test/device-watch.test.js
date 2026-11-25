import { describe, it, expect } from 'vitest';
import path from 'node:path';
import W from '../lib/device-watch.js';
import T from '../lib/tui.js';
import { NOW, makeBoard } from './support/watch-board.js';

// Golden frames are stored as markup ("[violet b]text[/]") so a diff shows text and style together. Times are
// shown in UTC and the clock is fixed, so the files do not depend on the machine.
const SIZES = [[60, 16], [80, 24], [120, 30], [160, 40]];
const GOLD = (name) => path.join(import.meta.dirname, 'fixtures', 'device-watch', name);
const OPTS = { utc: true };
const sz = ([cols, rows]) => ({ cols, rows });
const ui0 = (s, o = {}) => ({ ...W.initialUi(sz(s)), ...o });
const frame = (board, ui, s, opts = OPTS) => W.renderFrame(board, ui, sz(s), NOW, opts);
const emptyBoard = () => ({ ...makeBoard(), devices: [], pools: [], hidden: { keys: 0 } });

describe('golden frames', () => {
  for (const s of SIZES) {
    const tag = `${s[0]}x${s[1]}`;
    const cases = {
      list: (b) => [b, ui0(s)],
      detail: (b) => [b, ui0(s, { focus: 'detail', detailOpen: true, runCursor: 2, selected: b.devices[0].id })],
      help: (b) => [b, ui0(s, { help: true })],
      paused: (b) => [b, ui0(s, { paused: true, pausedAt: b.at })],
      empty: () => [emptyBoard(), ui0(s)],
    };
    for (const [name, mk] of Object.entries(cases)) {
      it(`${name} ${tag}`, async () => {
        const [b, ui] = mk(makeBoard());
        const f = frame(b, ui, s);
        expect(f).toHaveLength(s[1]);
        for (const l of f) expect(T.toPlain([l])[0] && T.width(T.toPlain([l])[0])).toBe(s[0]);
        await expect(T.toMarkup(f)).toMatchFileSnapshot(GOLD(`${name}-${tag}.frame`));
      });
    }
    it(`no-color plain text ${tag}`, async () => {
      const f = frame(makeBoard(), ui0(s), s, { ...OPTS, level: 'none' });
      await expect(T.toPlain(f).join('\n') + '\n').toMatchFileSnapshot(GOLD(`list-${tag}.plain`));
    });
  }
  it('too small', async () => {
    const f = frame(makeBoard(), ui0([50, 10]), [50, 10]);
    expect(f).toHaveLength(10);
    expect(T.toPlain(f).join('\n')).toContain('terminal too small (need 60x16)');
    await expect(T.toMarkup(f)).toMatchFileSnapshot(GOLD('toosmall-50x10.frame'));
    expect(W.renderModel(makeBoard(), ui0([59, 24]), { cols: 59, rows: 24 }, NOW).layout).toBe('tooSmall');
    expect(W.renderModel(makeBoard(), ui0([80, 15]), { cols: 80, rows: 15 }, NOW).layout).toBe('tooSmall');
  });
  it('truecolor ANSI serialization of one frame (escapes shown as a symbol)', async () => {
    const f = frame(makeBoard(), ui0([80, 24]), [80, 24]);
    await expect(T.toAnsi(f, 'truecolor').join('\n').replace(/\x1b/g, '␛') + '\n').toMatchFileSnapshot(GOLD('list-80x24-truecolor.ansi'));
  });
  it('16-color and none output carry no backgrounds', () => {
    const f = frame(makeBoard(), ui0([80, 24], { focus: 'detail' }), [80, 24]);
    const c16 = T.toAnsi(f, '16').join('');
    expect(c16).not.toMatch(/48;|\x1b\[[0-9;]*4[0-7]m/);
    const none = T.toAnsi(f, 'none').join('');
    expect(none).not.toMatch(/\x1b\[[0-9;]*(3[0-9]|9[0-7]|48)[;m]/);
  });
  it('layout switches to side by side at 120 columns', () => {
    expect(W.renderModel(makeBoard(), ui0([119, 30]), sz([119, 30]), NOW).layout).toBe('stacked');
    expect(W.renderModel(makeBoard(), ui0([120, 30]), sz([120, 30]), NOW).layout).toBe('side');
  });
  it('the none level marks the selection with > and the unicode level with a bar', () => {
    const none = T.toPlain(frame(makeBoard(), ui0([80, 24]), [80, 24], { ...OPTS, level: 'none' })).join('\n');
    expect(none).toContain('│> ●');
    expect(T.toPlain(frame(makeBoard(), ui0([80, 24]), [80, 24])).join('\n')).toContain('│▎ ●');
  });
});

describe('hostile board values', () => {
  it('a purpose with an OSC title sequence renders without the escape', () => {
    const b = makeBoard();
    b.devices[0].holder.purpose = 'e2e \x1b]0;pwned\x07run';
    b.devices[0].queue[0].purpose = '\x1b[2Jwipe';
    b.devices[0].runs[1].agent = '‮evil\x1b]8;;http://x\x07';
    b.devices[0].label = 'lab\x1bP...\x1b\\-a';
    b.devices[0].holder.branch = 'x'.repeat(100000);
    b.dir = '\x1b]0;t\x07/dir';
    for (const s of SIZES) {
      for (const ui of [ui0(s), ui0(s, { focus: 'detail' })]) {
        const all = T.toAnsi(frame(b, ui, s), 'truecolor').join('\n') + W.renderOnce(b, { now: NOW, utc: true, level: 'none' }) + W.renderPlainBlock(b, { now: NOW, utc: true });
        expect(all.replace(/\x1b\[[0-9;]*m/g, '')).not.toContain('\x1b');
        expect(all).not.toContain('pwned');
        expect(all).not.toContain('wipe\x1b');
      }
    }
  });
  it('coerces non-string values and survives missing fields', () => {
    const b = makeBoard();
    b.devices[0].holder.agent = 12345; b.devices[0].holder.purpose = { a: 1 }; b.devices[0].runs[0].purpose = null;
    b.devices[1].reach = undefined; b.devices[2].stats = undefined; b.devices[1].queue = undefined; b.devices[2].runs = undefined;
    for (const s of SIZES) expect(() => frame(b, ui0(s), s)).not.toThrow();
    expect(() => W.renderOnce(b, { now: NOW })).not.toThrow();
  });
  it('wide and combining characters keep every row at the exact width', () => {
    const b = makeBoard();
    b.devices[0].label = '日本語デバイス'; b.devices[0].holder.agent = 'ééé😀😀'; b.devices[0].queue[0].purpose = '漢字'.repeat(40);
    for (const s of SIZES) for (const l of frame(b, ui0(s, { focus: 'detail' }), s)) expect(T.width(T.toPlain([l])[0])).toBe(s[0]);
  });
});

describe('view model', () => {
  const m = (s = [120, 30], ui = {}) => W.renderModel(makeBoard(), ui0(s, ui), sz(s), NOW, OPTS);
  it('exposes pane lines cut to the pane width', () => {
    const model = m();
    expect(model.devices.lines.length).toBe(model.lay.list.h - 2);
    for (const l of model.devices.lines) expect(T.width(T.toPlain([l])[0])).toBe(model.lay.list.w - 2);
    for (const l of model.detail.lines) expect(T.width(T.toPlain([l])[0])).toBe(model.lay.detail.w - 2);
    expect(model.selected).toBe('id-aaaaaaaaaaaaaaaa');
  });
  it('detail shows wait then hold bars, and the vertical strip has one bar per run', () => {
    const text = T.toPlain(m().detail.lines).join('\n');
    expect(text).toMatch(/░+█+[▏▎▍▌▋▊▉]? +2m00s +2m05s ok/);
    const strip = T.toPlain(m().devices.lines).find((l) => l.includes('runs '));
    expect((strip.match(/[▁▂▃▄▅▆▇█]/g) || []).length).toBe(10);
  });
  it('bars: scaled, minimum one cell, colored by outcome', () => {
    const G = T.GLYPHS.unicode;
    const bar = (w, h, role = 'runOk') => T.toPlain([W.barSpans(w, h, 100, 10, role, G)])[0];
    expect(bar(0, 100)).toBe('██████████'); expect(bar(0, 50)).toBe('█████     ');
    expect(bar(50, 50)).toBe('░░░░░█████'); // 5 wait cells then 5 hold cells
    expect(bar(0, 1)).toBe('▏         ');
    expect(bar(1, 0)).toBe('░         ');
    expect(bar(0, 0)).toBe('          ');
    expect(W.barSpans(0, 10, 100, 10, 'runFailed', G)[0].fg).toBe('runFailed');
    expect(W.barSpans(10, 0, 100, 10, 'runFailed', G)[0].fg).toBe('waitBar');
    expect(W.barSpans(5, 5, 100, 0, 'runOk', G)).toEqual([]);
    expect(bar(0, 12)).toBe('█▎        '); // eighth-block precision: 1.2 cells
    expect(T.width(bar(1000, 1000))).toBe(10);
  });
  it('run outcomes: ok, exit N, lost, reclaimed, forced, gave up, running', () => {
    const t = (r) => W.runOutcome(r);
    expect(t({ ended: 'released', exitCode: 0 })).toEqual({ role: 'runOk', text: 'ok' });
    expect(t({ ended: 'released', exitCode: null })).toEqual({ role: 'runOk', text: 'ok' });
    expect(t({ ended: 'released', exitCode: 1 })).toEqual({ role: 'runFailed', text: 'exit 1' });
    expect(t({ ended: 'lost' }).role).toBe('runFailed'); expect(t({ ended: 'reclaimed' }).text).toBe('reclaimed');
    expect(t({ ended: 'forced' }).text).toBe('forced'); expect(t({ ended: 'timeout' }).text).toBe('gave up');
    expect(t({ ended: 'running' }).role).toBe('running'); expect(t({ ended: 'unknown' }).role).toBe('meta');
  });
  it('ages grow with the clock and freeze while paused', () => {
    const b = makeBoard();
    const at = (now, ui) => T.toPlain(W.renderModel(b, ui0([120, 30], ui), sz([120, 30]), now, OPTS).devices.lines).join('\n');
    expect(at(NOW, {})).toContain('4m12s');
    expect(at(NOW + 60000, {})).toContain('5m12s');
    expect(at(NOW + 60000, { paused: true, pausedAt: b.at })).toContain('4m12s');
    const head = T.toPlain([W.renderModel(b, ui0([120, 30], { paused: true, pausedAt: b.at }), sz([120, 30]), NOW + 99999, OPTS).header])[0];
    expect(head).toContain('PAUSED 10:41:03');
  });
  it('the selection follows the device id when the list reorders or shrinks', () => {
    const b = makeBoard();
    const sel = { selected: 'id-bbbbbbbbbbbbbbbb', selectedIndex: 1 };
    expect(W.selectedIndexOf(b, ui0([80, 24], sel))).toBe(1);
    const reordered = { ...b, devices: [b.devices[2], b.devices[1], b.devices[0]] };
    expect(W.selectedIndexOf(reordered, ui0([80, 24], sel))).toBe(1);
    const gone = { ...b, devices: [b.devices[0], b.devices[2]] };
    expect(W.selectedIndexOf(gone, ui0([80, 24], sel))).toBe(1);
    expect(W.selectedIndexOf({ devices: [] }, ui0([80, 24], sel))).toBe(-1);
  });
  it('a long device list scrolls around the selection', () => {
    const b = makeBoard();
    b.devices = Array.from({ length: 30 }, (_, i) => ({ ...b.devices[1], id: `d${i}`, label: `dev-${i}` }));
    const model = W.renderModel(b, ui0([80, 24], { selected: 'd25', selectedIndex: 25 }), sz([80, 24]), NOW, OPTS);
    expect(T.toPlain(model.devices.lines).join('\n')).toContain('dev-25');
  });
});

describe('reduce', () => {
  const board = makeBoard();
  const R = (ui, key, b = board) => W.reduce(ui, key, b);
  const base = () => ui0([120, 30]);
  it('moves the selection with arrows and j/k, clamped, no wrap', () => {
    let u = base();
    expect(R(u, 'up').ui.selected).toBe(board.devices[0].id);
    u = R(u, 'down').ui; expect(u.selected).toBe(board.devices[1].id);
    u = R(u, 'j').ui; expect(u.selected).toBe(board.devices[2].id);
    u = R(u, 'down').ui; expect(u.selected).toBe(board.devices[2].id);
    u = R(u, 'k').ui; expect(u.selected).toBe(board.devices[1].id);
    expect(R(u, 'home').ui.selected).toBe(board.devices[0].id);
    expect(R(u, 'g').ui.selected).toBe(board.devices[0].id);
    expect(R(u, 'end').ui.selected).toBe(board.devices[2].id);
    expect(R(u, 'G').ui.selected).toBe(board.devices[2].id);
    expect(R(u, 'pagedown').ui.selected).toBe(board.devices[2].id);
    expect(R(R(u, 'end').ui, 'pageup').ui.selected).toBe(board.devices[0].id);
  });
  it('changing device resets the run cursor', () => {
    let u = { ...base(), focus: 'detail', runCursor: 3, runScroll: 1 };
    u = { ...R({ ...u, focus: 'devices' }, 'down').ui };
    expect(u.runCursor).toBe(0); expect(u.runScroll).toBe(0);
  });
  it('enter, right and l open the detail; left and h go back; tab toggles', () => {
    for (const k of ['enter', 'right', 'l']) { const u = R(base(), k).ui; expect(u.focus).toBe('detail'); expect(u.detailOpen).toBe(true); }
    const d = { ...base(), focus: 'detail', detailOpen: true };
    for (const k of ['left', 'h']) { const u = R(d, k).ui; expect(u.focus).toBe('devices'); expect(u.detailOpen).toBe(false); }
    expect(R(base(), 'tab').ui.focus).toBe('detail'); expect(R(d, 'tab').ui.focus).toBe('devices');
    expect(R(base(), 'shift-tab').ui.focus).toBe('detail');
  });
  it('in the detail pane arrows move the run cursor and scroll to keep it visible', () => {
    let u = { ...ui0([60, 16]), focus: 'detail', detailOpen: true };
    const visible = W.renderModel(board, u, { cols: 60, rows: 16 }, NOW, OPTS).detail.runs.visible;
    expect(visible).toBeGreaterThan(0);
    for (let i = 0; i < 6; i++) u = R(u, 'down').ui;
    expect(u.runCursor).toBe(6);
    expect(u.runScroll).toBe(6 - visible + 1);
    expect(u.selected).toBe(board.devices[0].id);
    for (let i = 0; i < 20; i++) u = R(u, 'j').ui;
    expect(u.runCursor).toBe(9);
    u = R(u, 'g').ui; expect(u.runCursor).toBe(0); expect(u.runScroll).toBe(0);
    u = R(u, 'G').ui; expect(u.runCursor).toBe(9);
    u = R(u, 'up').ui; expect(u.runCursor).toBe(8);
    expect(R(u, 'pageup').ui.runCursor).toBeLessThan(8);
  });
  it('a toggles all and asks for a snapshot', () => {
    const r = R(base(), 'a');
    expect(r.ui.all).toBe(true); expect(r.effects).toEqual(['snapshot', 'render']);
    expect(R(r.ui, 'a').ui.all).toBe(false);
  });
  it('p pauses, freezes the time at the board time, and resumes with a snapshot', () => {
    const r = R(base(), 'p');
    expect(r.ui.paused).toBe(true); expect(r.ui.pausedAt).toBe(board.at); expect(r.effects).toEqual(['render']);
    const back = R(r.ui, 'p');
    expect(back.ui.paused).toBe(false); expect(back.ui.pausedAt).toBeNull(); expect(back.effects).toEqual(['snapshot', 'render']);
  });
  it('r refreshes, except while paused', () => {
    expect(R(base(), 'r').effects).toEqual(['snapshot', 'render']);
    expect(R({ ...base(), paused: true, pausedAt: board.at }, 'r').effects).not.toContain('snapshot');
  });
  it('? opens help; any key closes it; ctrl-c still quits', () => {
    const open = R(base(), '?').ui; expect(open.help).toBe(true);
    for (const k of ['x', 'down', 'q', 'escape', 'enter', '?']) { const r = R(open, k); expect(r.ui.help).toBe(false); expect(r.effects).toEqual(['render']); }
    expect(R(open, 'ctrl-c').effects).toEqual(['quit']);
  });
  it('quits on q, ctrl-c and escape from the list; ignores ctrl-z and unknown keys', () => {
    expect(R(base(), 'q').effects).toEqual(['quit']); expect(R(base(), 'ctrl-c').effects).toEqual(['quit']);
    expect(R(base(), 'escape').effects).toEqual(['quit']);
    expect(R(base(), 'ctrl-z').effects).toEqual([]); expect(R(base(), 'z').effects).toEqual([]);
  });
  it('escape order: close the overlay, then back to the list, then quit', () => {
    let u = { ...base(), focus: 'detail', detailOpen: true, help: true };
    let r = R(u, 'escape'); expect(r.effects).toEqual(['render']); expect(r.ui.help).toBe(false); expect(r.ui.focus).toBe('detail');
    r = R(r.ui, 'escape'); expect(r.effects).toEqual(['render']); expect(r.ui.focus).toBe('devices');
    r = R(r.ui, 'escape'); expect(r.effects).toEqual(['quit']);
  });
  it('is pure: the input ui is never mutated, and empty boards do not throw', () => {
    const u = Object.freeze(base());
    expect(() => R(u, 'down')).not.toThrow();
    const empty = emptyBoard();
    for (const k of ['up', 'down', 'enter', 'g', 'G', 'pagedown', 'tab', 'a', 'p', '?']) expect(() => W.reduce(base(), k, empty)).not.toThrow();
    expect(() => W.reduce(base(), 'down', null)).not.toThrow();
  });
  it('resize updates the size', () => {
    expect(W.resize(base(), { cols: 70, rows: 20 })).toMatchObject({ cols: 70, rows: 20 });
  });
});

describe('inkKeyName', () => {
  const rows = [
    ['', { upArrow: true }, 'up'], ['', { downArrow: true }, 'down'], ['', { leftArrow: true }, 'left'], ['', { rightArrow: true }, 'right'],
    ['', { return: true }, 'enter'], ['', { escape: true }, 'escape'], ['', { tab: true }, 'tab'], ['', { tab: true, shift: true }, 'shift-tab'],
    ['', { pageUp: true }, 'pageup'], ['', { pageDown: true }, 'pagedown'], ['', { home: true }, 'home'], ['', { end: true }, 'end'],
    ['c', { ctrl: true }, 'ctrl-c'], ['z', { ctrl: true }, 'ctrl-z'], ['\x03', {}, 'ctrl-c'],
    ['q', {}, 'q'], ['G', {}, 'G'], ['?', {}, '?'], ['j', {}, 'j'],
    ['q', { ctrl: true }, null], ['x', { meta: true }, null], ['', { backspace: true }, null], ['abc', {}, null], ['', {}, null], ['\x7f', {}, null],
  ];
  for (const [input, key, want] of rows) it(`${JSON.stringify(input)} ${JSON.stringify(key)} -> ${want}`, () => expect(W.inkKeyName(input, key)).toBe(want));
  it('handles a missing key object', () => expect(W.inkKeyName('q')).toBe('q'));
});

describe('static renderer', () => {
  it('--once text (no color) matches the layout', async () => {
    await expect(W.renderOnce(makeBoard(), { now: NOW, utc: true })).toMatchFileSnapshot(GOLD('once.txt'));
  });
  it('--once on a color terminal uses foreground colors only', () => {
    const s = W.renderOnce(makeBoard(), { now: NOW, utc: true, level: 'truecolor' });
    expect(s).toContain('\x1b[38;2;124;108;255m');
    expect(s).not.toMatch(/48;2|\x1b\[[0-9;]*4[0-7]m/);
    expect(W.renderOnce(makeBoard(), { now: NOW, utc: true })).not.toContain('\x1b');
  });
  it('plain block names the quit key and never has color', () => {
    const s = W.renderPlainBlock(makeBoard(), { now: NOW, utc: true, intervalMs: 2000 });
    expect(s).toContain('every 2s · Ctrl-C quits'); expect(s).not.toContain('\x1b');
  });
  it('empty board and hidden keys', () => {
    expect(W.renderOnce({ ...emptyBoard(), hidden: { keys: 7 } }, { now: NOW, utc: true })).toContain('No devices known yet');
    expect(W.renderOnce({ ...emptyBoard(), hidden: { keys: 7 } }, { now: NOW, utc: true })).toContain('7 hidden');
  });
  it('--json is the board, pretty printed, and never has a full lease id', () => {
    const b = makeBoard();
    const s = W.renderJson(b);
    expect(JSON.parse(s)).toEqual(b); expect(s.endsWith('\n')).toBe(true);
    expect(W.renderJson({ ...b, dir: 'a\x1bb' })).not.toContain('\x1b');
  });
});

describe('modes, interval and the plain loop', () => {
  const tty = { stdoutIsTTY: true, stdinIsTTY: true, env: {}, platform: 'linux' };
  it('chooses the mode once', () => {
    expect(W.chooseMode({ ...tty, flags: { json: true, once: true } })).toBe('json');
    expect(W.chooseMode({ ...tty, flags: { once: true } })).toBe('once');
    expect(W.chooseMode({ ...tty, flags: {} })).toBe('tui');
    expect(W.chooseMode({ ...tty, flags: { plain: true } })).toBe('plain');
    expect(W.chooseMode({ ...tty, stdoutIsTTY: false, flags: {} })).toBe('plain');
    expect(W.chooseMode({ ...tty, stdinIsTTY: false, flags: {} })).toBe('plain');
    expect(W.chooseMode({ ...tty, env: { TERM: 'dumb' }, flags: {} })).toBe('plain');
    expect(W.chooseMode({ ...tty, platform: 'win32', release: '10.0.17134', flags: {} })).toBe('plain');
    expect(W.chooseMode({ ...tty, platform: 'win32', release: '10.0.17763', flags: {} })).toBe('tui');
    expect(W.chooseMode({ ...tty, platform: 'win32', release: '10.0.22631', flags: {} })).toBe('tui');
    expect(W.chooseMode({ ...tty, platform: 'darwin', release: '10.0.100', flags: {} })).toBe('tui');
  });
  it('parses intervals', () => {
    expect(W.parseInterval('2s')).toBe(2000); expect(W.parseInterval('500ms')).toBe(500); expect(W.parseInterval('1.5s')).toBe(1500);
    expect(W.parseInterval('1m')).toBe(60000); expect(W.parseInterval('750')).toBe(750);
    for (const bad of ['', 'x', '100ms', '-1s', '0', '2h']) expect(() => W.parseInterval(bad)).toThrow(RangeError);
  });
  const fakeIo = (extra = {}) => { const out = []; const err = []; return { out, err, io: { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, stdoutIsTTY: false, stdinIsTTY: false, env: {}, platform: 'linux', now: () => NOW, ...extra } }; };
  const view = (b = makeBoard()) => { const calls = []; return { calls, snapshot: (o) => { calls.push(o); return b; } }; };
  it('json mode writes one board and returns 0', async () => {
    const { io, out } = fakeIo(); const v = view();
    expect(await W.runWatch({ view: v, flags: { json: true, host: 'h', all: true, tail: 5 }, io })).toBe(0);
    expect(JSON.parse(out.join('')).schema).toBe('brighttest-lease-board/v1');
    expect(v.calls).toEqual([{ host: 'h', all: true, historyN: 5 }]);
  });
  it('once mode writes one static board', async () => {
    const { io, out } = fakeIo();
    expect(await W.runWatch({ view: view(), flags: { once: true, utc: true }, io })).toBe(0);
    expect(out).toHaveLength(1); expect(out[0]).toContain('DEVICE'); expect(out[0]).not.toContain('\x1b');
  });
  it('plain loop repeats per interval, separated by a blank line, until aborted', async () => {
    const { io, out } = fakeIo(); const ac = new AbortController(); let n = 0;
    io.sleep = async () => { if (++n >= 2) ac.abort(); };
    expect(await W.runWatch({ view: view(), flags: { intervalMs: 1000 }, io, signal: ac.signal })).toBe(0);
    expect(out).toHaveLength(2); expect(out[0].startsWith('brighttest device watch')).toBe(true); expect(out[1].startsWith('\n')).toBe(true);
  });
  it('the TUI choice falls back to the plain loop until a live screen is supplied', async () => {
    const { io, out } = fakeIo({ stdoutIsTTY: true, stdinIsTTY: true }); const ac = new AbortController();
    io.sleep = async () => ac.abort();
    expect(await W.runWatch({ view: view(), flags: {}, io, signal: ac.signal })).toBe(0);
    expect(out).toHaveLength(1);
    const { io: io2 } = fakeIo({ stdoutIsTTY: true, stdinIsTTY: true });
    expect(await W.runWatch({ view: view(), flags: {}, io: io2, tui: async () => 7 })).toBe(7);
  });
  it('a pre-aborted signal ends the plain loop without output', async () => {
    const { io, out } = fakeIo(); const ac = new AbortController(); ac.abort();
    expect(await W.runWatch({ view: view(), flags: { plain: true }, io, signal: ac.signal })).toBe(0);
    expect(out).toHaveLength(0);
  });
});
