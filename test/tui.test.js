import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import T from '../lib/tui.js';

const CSS = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'studio', 'web', 'src', 'app.css'), 'utf8');

describe('palette', () => {
  it('has the Studio tokens, and every hex matches app.css (drift test)', () => {
    const css = {};
    for (const m of CSS.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) css[m[1]] = m[2].toLowerCase();
    const kebab = (k) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
    for (const [name, hex] of Object.entries(T.TOKENS)) {
      expect(css[kebab(name)], `app.css --color-${kebab(name)}`).toBe(hex);
    }
    expect(T.TOKENS).toMatchObject({ ink: '#0c0e14', panel: '#141824', line: '#232838', haze: '#8a90a6', text: '#e7eaf3', violet: '#7c6cff', amber: '#ffc24b', pass: '#45d483', fail: '#ff5d6c' });
  });
  it('maps states to roles', () => {
    expect(T.ROLES).toMatchObject({ held: 'violet', free: 'pass', up: 'pass', queued: 'amber', waitBar: 'amber', stale: 'fail', unreachable: 'fail', corrupt: 'fail', runFailed: 'fail', unknown: 'haze', running: 'violet' });
    for (const tok of Object.values(T.ROLES)) expect(T.TOKENS[tok]).toBeTruthy();
  });
  it('picks the nearest xterm-256 entry for every token', () => {
    const dist = (a, b) => { const rm = (a[0] + b[0]) / 2; return (2 + rm / 256) * (a[0] - b[0]) ** 2 + 4 * (a[1] - b[1]) ** 2 + (2 + (255 - rm) / 256) * (a[2] - b[2]) ** 2; };
    for (const [name, hex] of Object.entries(T.TOKENS)) {
      const idx = T.INDEX256[name];
      expect(idx).toBeGreaterThanOrEqual(16); expect(idx).toBeLessThan(256);
      const rgb = T.hexToRgb(hex);
      const table = (i) => { if (i >= 232) { const v = 8 + (i - 232) * 10; return [v, v, v]; } const n = i - 16; const s = [0, 95, 135, 175, 215, 255]; return [s[Math.floor(n / 36)], s[Math.floor(n / 6) % 6], s[n % 6]]; };
      const mine = dist(rgb, table(idx));
      for (let i = 16; i < 256; i++) expect(dist(rgb, table(i))).toBeGreaterThanOrEqual(mine);
    }
    expect(T.INDEX256.violet).toBe(99); // #7c6cff is closest to the 5f5fff-ish cube entry
  });
});

describe('detectColorLevel', () => {
  const d = (env, extra = {}) => T.detectColorLevel({ env, isTTY: true, platform: 'linux', ...extra });
  const rows = [
    [{ FORCE_COLOR: '0' }, 'none'], [{ FORCE_COLOR: 'false' }, 'none'], [{ FORCE_COLOR: '1' }, '16'], [{ FORCE_COLOR: 'true' }, '16'],
    [{ FORCE_COLOR: '' }, '16'], [{ FORCE_COLOR: '2' }, '256'], [{ FORCE_COLOR: '3' }, 'truecolor'],
    [{ FORCE_COLOR: '3', NO_COLOR: '1' }, 'truecolor'], [{ FORCE_COLOR: 'banana', COLORTERM: 'truecolor' }, 'none'], [{ NO_COLOR: '1' }, 'none'], [{ NO_COLOR: '' , COLORTERM: 'truecolor' }, 'truecolor'],
    [{ TERM: 'dumb', COLORTERM: 'truecolor' }, 'none'], [{ COLORTERM: 'truecolor' }, 'truecolor'], [{ COLORTERM: '24bit' }, 'truecolor'],
    [{ WT_SESSION: 'x' }, 'truecolor'], [{ TERM: 'xterm-256color' }, '256'], [{ TERM: 'xterm' }, 'none'],
  ];
  for (const [env, want] of rows) it(`${JSON.stringify(env)} -> ${want}`, () => expect(d(env)).toBe(want));
  it('not a TTY -> none unless FORCE_COLOR', () => {
    expect(d({ COLORTERM: 'truecolor' }, { isTTY: false })).toBe('none');
    expect(d({ FORCE_COLOR: '2' }, { isTTY: false })).toBe('256');
  });
  it('falls back to getColorDepth', () => {
    expect(d({}, { getColorDepth: () => 24 })).toBe('truecolor');
    expect(d({}, { getColorDepth: () => 8 })).toBe('256');
    expect(d({}, { getColorDepth: () => 4 })).toBe('16');
    expect(d({}, { getColorDepth: () => 1 })).toBe('none');
    expect(d({}, { getColorDepth: () => { throw new Error('x'); } })).toBe('none');
  });
});

describe('toAnsi per level', () => {
  const line = [[T.S('go', 'violet', { b: true }), T.S('x', 'amber', { bg: 'panel' }), T.S('sel', 'text', { sel: true }), T.S('plain')]];
  it('truecolor paints foreground and background', () => {
    expect(T.toAnsi(line, 'truecolor')[0]).toBe('\x1b[1;38;2;124;108;255mgo\x1b[0m\x1b[38;2;255;194;75;48;2;20;24;36mx\x1b[0m\x1b[38;2;231;234;243msel\x1b[0mplain');
  });
  it('256 uses the computed indexes', () => {
    expect(T.toAnsi(line, '256')[0]).toContain(`38;5;${T.INDEX256.violet}`);
    expect(T.toAnsi(line, '256')[0]).toContain(`48;5;${T.INDEX256.panel}`);
  });
  it('16 colors: foreground codes only, no backgrounds, selection is inverse', () => {
    const s = T.toAnsi(line, '16')[0];
    expect(s).toBe('\x1b[1;95mgo\x1b[0m\x1b[33mx\x1b[0m\x1b[7;39msel\x1b[0mplain');
    expect(s).not.toMatch(/\x1b\[[0-9;]*(48|4[0-7]|10[0-7])[;m]/);
  });
  it('none: no color codes at all (bold and inverse may stay)', () => {
    const s = T.toAnsi(line, 'none')[0];
    expect(s).toBe('\x1b[1mgo\x1b[0mx\x1b[7msel\x1b[0mplain');
    expect(s).not.toMatch(/\x1b\[[0-9;]*(3[0-9]|9[0-7]|48)[;m]/);
  });
  it('toPlain drops styling; toMarkup keeps it', () => {
    expect(T.toPlain(line)[0]).toBe('goxselplain');
    expect(T.toMarkup(line)).toBe('[violet b]go[/][amber bg:panel]x[/][text sel]sel[/]plain\n');
  });
});

describe('inkColor', () => {
  it('truecolor gives hex, 256 gives ansi256(n), 16 gives names, none gives nothing', () => {
    expect(T.inkColor('held', 'truecolor')).toBe('#7c6cff');
    expect(T.inkColor('violet', '256')).toBe(`ansi256(${T.INDEX256.violet})`);
    expect(T.inkColor('fail', '16')).toBe('red');
    expect(T.inkColor('pass', '16')).toBe('green');
    expect(T.inkColor('fail', 'none')).toBeUndefined();
    expect(T.inkColor('nope', 'truecolor')).toBeUndefined();
  });
  it('16 and none never return a background', () => {
    for (const tok of Object.keys(T.TOKENS)) {
      expect(T.inkColor(tok, '16', 'bg')).toBeUndefined();
      expect(T.inkColor(tok, 'none', 'bg')).toBeUndefined();
      expect(T.inkColor(tok, 'truecolor', 'bg')).toBe(T.TOKENS[tok]);
    }
  });
});

describe('sanitize', () => {
  it('a removed escape sequence never swallows the next ordinary character', () => {
    expect(T.sanitize('a\x1b\x1b]0;x\x07b')).toBe('ab');
    expect(T.sanitize('\x1b\x1b[31mz')).toBe('z');
    expect(T.sanitize('\x1b\x1b\x1b[31mz')).toBe('z');
    expect(T.sanitize('ab\x1b')).toBe('ab');
    expect(T.sanitize('a\x1b]0;unterminated rest')).toBe('a');
    expect(T.sanitize('a\u0080\u009b31mb\u009d')).toBe('a31mb');
    expect(T.sanitize('caf\u00e9 \u65e5\u672c \ud83d\ude80')).toBe('caf\u00e9 \u65e5\u672c \ud83d\ude80');
    expect(Array.from(T.sanitize('x'.repeat(400))).length).toBe(200);
    expect(Array.from(T.sanitize('x'.repeat(400), 300)).length).toBe(300);
  });
  it('removes OSC, CSI and other escape sequences', () => {
    expect(T.sanitize('e2e \x1b]0;pwned\x07run')).toBe('e2e run');
    expect(T.sanitize('a\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\b')).toBe('alinkb');
    expect(T.sanitize('\x1b[31mred\x1b[0m \x1b[2J\x1b[H!')).toBe('red !');
    expect(T.sanitize('x\x1bPq#0;2;0;0;0\x1b\\y')).toBe('xy');
    expect(T.sanitize('a\x1bcb')).toBe('ab');
    expect(T.sanitize('\x1b]0;unterminated')).toBe('');
  });
  it('removes control characters, C1 and DEL; tabs and newlines become spaces', () => {
    expect(T.sanitize('a\x00b\x07c\x7fd\x9be\x85f')).toBe('abcdef');
    expect(T.sanitize('a\tb\nc\r\nd')).toBe('a b c  d');
    expect(T.sanitize('a b')).toBe('a b');
  });
  it('removes bidi, zero-width and tag characters', () => {
    expect(T.sanitize('a‮b​c⁦d﻿e\u{e0041}f­g')).toBe('abcdefg');
  });
  it('coerces values to strings', () => {
    expect(T.sanitize(42)).toBe('42'); expect(T.sanitize(true)).toBe('true');
    expect(T.sanitize(null)).toBe(''); expect(T.sanitize(undefined)).toBe(''); expect(T.sanitize({ a: 1 })).toBe(''); expect(T.sanitize(['x'])).toBe('');
  });
  it('caps very long strings with an ellipsis, counting characters not bytes', () => {
    const out = T.sanitize('x'.repeat(100000), 50);
    expect(Array.from(out)).toHaveLength(50); expect(out.endsWith('…')).toBe(true);
    expect(T.sanitize('😀'.repeat(10), 4)).toBe('😀😀😀…');
    expect(T.sanitize('short', 50)).toBe('short');
  });
  it('output never contains an ESC', () => {
    expect(T.sanitize('\x1b\x1b\x1b[\x1b]\x1b')).not.toContain('\x1b');
  });
});

describe('width, truncate, pad', () => {
  it('counts wide as 2 and combining as 0', () => {
    expect(T.width('abc')).toBe(3); expect(T.width('日本')).toBe(4); expect(T.width('é')).toBe(1);
    expect(T.width('😀')).toBe(2); expect(T.width('⚠●▎█')).toBe(4); expect(T.width('')).toBe(0);
  });
  it('truncates to a display width with an ellipsis', () => {
    expect(T.truncate('hello world', 8)).toBe('hello w…');
    expect(T.truncate('hello', 8)).toBe('hello');
    expect(T.truncate('日本語です', 6)).toBe('日本…');
    expect(T.width(T.truncate('日本語です', 6))).toBeLessThanOrEqual(6);
    expect(T.truncate('abc', 0)).toBe(''); expect(T.truncate('abc', 1)).toBe('…');
    expect(T.truncate('ééé', 2)).toBe('é…');
  });
  it('pads to an exact width', () => {
    expect(T.pad('ab', 5)).toBe('ab   '); expect(T.pad('ab', 5, 'right')).toBe('   ab');
    expect(T.width(T.pad('日本語', 5))).toBe(5); expect(T.pad('abcdef', 4)).toBe('abc…');
  });
});

describe('emoji and cluster widths', () => {
  const table = [
    ['a', 1], ['✅', 2], ['⌚', 2], ['⚡', 2], ['⭐', 2], ['⚠', 1], ['⚠️', 2], ['●', 1], ['❤️', 2], ['1️⃣', 2], ['#️⃣', 2],
    ['🇺🇸', 2], ['👍', 2], ['👍🏽', 2], ['👨‍👩‍👧', 2], ['日', 2], ['e\u0301', 1], ['한', 2], ['가\u1161', 2], ['\u1161', 0], ['─', 1], ['▎', 1], ['≡', 1],
    ['\u200b', 0], ['', 0],
  ];
  for (const [text, want] of table) it(`${JSON.stringify(text)} is ${want} cells`, () => expect(T.width(text)).toBe(want));
  it('sums over a mixed string', () => expect(T.width('a✅🇺🇸日e\u0301')).toBe(1 + 2 + 2 + 2 + 1));
  it('truncate and pad never split a cluster and respect the width', () => {
    for (const text of ['🇺🇸🇺🇸🇺🇸', '👍🏽👍🏽👍🏽', '⚠️⚠️⚠️', '1️⃣1️⃣1️⃣', '👨‍👩‍👧x👨‍👩‍👧', 'e\u0301e\u0301e\u0301', 'a✅b✅c✅']) {
      for (let w = 0; w <= 10; w++) {
        const t = T.truncate(text, w);
        expect(T.width(t)).toBeLessThanOrEqual(w);
        expect(T.width(T.pad(text, w))).toBe(w);
        expect(text.startsWith(t.replace(/…$/, ''))).toBe(true);
      }
    }
    expect(T.truncate('🇺🇸🇺🇸🇺🇸', 5)).toBe('🇺🇸🇺🇸…');
  });
  it('jsonSafe escapes the risky code points and keeps the value', () => {
    const v = 'x\u007f\u0085\u202e\u2028\u{e0041}y';
    const out = T.jsonSafe(JSON.stringify(v));
    expect(out).not.toMatch(/[\u007f-\u009f\u202e\u2028]|[\u{e0000}-\u{e007f}]/u);
    expect(JSON.parse(out)).toBe(v);
  });
});

describe('glyphs', () => {
  it('uses the ASCII set on the Linux console', () => {
    expect(T.glyphSet({ TERM: 'linux' })).toBe(T.GLYPHS.ascii);
    expect(T.glyphSet({ TERM: 'xterm' })).toBe(T.GLYPHS.unicode);
    for (const g of Object.values(T.GLYPHS)) expect(g.blocks).toHaveLength(8);
  });
});
