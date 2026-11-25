'use strict';

// Small, pure toolkit for terminal views: the Studio color palette, color-level detection, styled text
// ("spans"), text safety and display-width helpers. No terminal I/O and no dependency: everything here takes
// values in and returns values out, so it can be tested without a terminal.
//
// The token names and hex values come from Studio's stylesheet (lib/studio/web/src/app.css, `--color-*`), and a
// test fails if they drift apart. Renderers style by ROLE (held, free, queued ...), never by hex.

// ---- palette -----------------------------------------------------------------------------------
const TOKENS = Object.freeze({
  ink: '#0c0e14',
  panel: '#141824',
  panel2: '#1b2030',
  line: '#232838',
  line2: '#2f3648',
  haze: '#8a90a6',
  text: '#e7eaf3',
  violet: '#7c6cff',
  violetDim: '#5a4fd6',
  amber: '#ffc24b',
  pass: '#45d483',
  fail: '#ff5d6c',
});

// What each state means, in color. Shared in spirit with the Studio panel.
const ROLES = Object.freeze({
  held: 'violet', free: 'pass', stale: 'fail', corrupt: 'fail',
  queued: 'amber', waitBar: 'amber', up: 'pass', unreachable: 'fail', unknown: 'haze',
  runOk: 'pass', runFailed: 'fail', running: 'violet', meta: 'haze', accent: 'violet',
});

// 16-color foreground codes (and the matching color names a layout library uses). No backgrounds at this level,
// so a light terminal theme stays readable. `null` = leave the terminal's own color.
const SGR16 = Object.freeze({
  ink: null, panel: null, panel2: null, line: 90, line2: 90, haze: 90, text: 39,
  violet: 95, violetDim: 35, amber: 33, pass: 32, fail: 31,
});
const NAME16 = Object.freeze({ 90: 'gray', 95: 'magentaBright', 35: 'magenta', 33: 'yellow', 32: 'green', 31: 'red' });

function hexToRgb(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

// The xterm 256-color table entries 16..255 (the first 16 are the user's theme colors, so they are skipped).
function xterm256(i) {
  if (i >= 232) { const v = 8 + (i - 232) * 10; return [v, v, v]; }
  const n = i - 16; const steps = [0, 95, 135, 175, 215, 255];
  return [steps[Math.floor(n / 36)], steps[Math.floor(n / 6) % 6], steps[n % 6]];
}
// Nearest table entry by "redmean" weighted distance (closer to how the eye sees color than plain RGB).
function nearest256(hex) {
  const [r, g, b] = hexToRgb(hex);
  let best = 16; let bestD = Infinity;
  for (let i = 16; i < 256; i++) {
    const [R, G, B] = xterm256(i);
    const rm = (r + R) / 2;
    const d = (2 + rm / 256) * (r - R) ** 2 + 4 * (g - G) ** 2 + (2 + (255 - rm) / 256) * (b - B) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}
const INDEX256 = Object.freeze(Object.fromEntries(Object.keys(TOKENS).map((k) => [k, nearest256(TOKENS[k])])));

// A role name or a token name -> a token name (unknown names return null).
function tokenOf(name) {
  if (!name) return null;
  const t = Object.prototype.hasOwnProperty.call(ROLES, name) ? ROLES[name] : name;
  return Object.prototype.hasOwnProperty.call(TOKENS, t) ? t : null;
}

// ---- color level -------------------------------------------------------------------------------
// 'truecolor' | '256' | '16' | 'none'. First rule that matches wins.
function detectColorLevel({ env = {}, isTTY = false, getColorDepth } = {}) {
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    const f = String(force).toLowerCase();
    if (f === '0' || f === 'false') return 'none';
    if (f === '' || f === '1' || f === 'true') return '16';
    if (f === '2') return '256';
    if (f === '3') return 'truecolor';
    return 'none'; // any other value: no color, as Node itself treats it
  }
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'none';
  if (!isTTY) return 'none';
  if (env.TERM === 'dumb') return 'none';
  const ct = String(env.COLORTERM || '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit') return 'truecolor';
  if (env.WT_SESSION) return 'truecolor';
  if (/256color$/.test(String(env.TERM || ''))) return '256';
  if (typeof getColorDepth === 'function') {
    let d = 0;
    try { d = getColorDepth(); } catch { d = 0; }
    if (d >= 24) return 'truecolor';
    if (d >= 8) return '256';
    if (d >= 4) return '16';
  }
  return 'none';
}

// The color to hand a layout library for a role: hex, `ansi256(n)`, a color name, or undefined (no color).
// `kind` is 'fg' or 'bg'. At 16 colors and below, backgrounds are never returned.
function inkColor(role, level, kind = 'fg') {
  const tok = tokenOf(role);
  if (!tok || level === 'none') return undefined;
  if (level === 'truecolor') return TOKENS[tok];
  if (level === '256') return `ansi256(${INDEX256[tok]})`;
  if (kind === 'bg') return undefined;
  const code = SGR16[tok];
  return code ? NAME16[code] : undefined;
}

// ---- spans -------------------------------------------------------------------------------------
// A span is { t: text, fg?, bg?, b? (bold), inv? (inverse), sel? (inverse where backgrounds are unavailable) }.
// A line is an array of spans. `fg` / `bg` are role or token names.
const S = (t, fg, extra) => ({ t: String(t), ...(fg ? { fg } : {}), ...(extra || {}) });

function sgrOf(span, level) {
  const codes = [];
  if (span.b) codes.push('1');
  const noBg = level === '16' || level === 'none';
  if (span.inv || (span.sel && noBg)) codes.push('7');
  const fg = tokenOf(span.fg);
  const bg = tokenOf(span.bg);
  if (fg && level === 'truecolor') codes.push('38;2;' + hexToRgb(TOKENS[fg]).join(';'));
  else if (fg && level === '256') codes.push('38;5;' + INDEX256[fg]);
  else if (fg && level === '16' && SGR16[fg]) codes.push(String(SGR16[fg]));
  if (bg && level === 'truecolor') codes.push('48;2;' + hexToRgb(TOKENS[bg]).join(';'));
  else if (bg && level === '256') codes.push('48;5;' + INDEX256[bg]);
  return codes.length ? `\x1b[${codes.join(';')}m` : '';
}
// One ANSI string per line. Each styled run is closed with a reset, so lines are independent.
function toAnsi(lines, level) {
  return lines.map((line) => line.map((sp) => {
    const sgr = sgrOf(sp, level);
    return sgr ? sgr + sp.t + '\x1b[0m' : sp.t;
  }).join(''));
}
function toPlain(lines) { return lines.map((line) => line.map((sp) => sp.t).join('')); }
// Readable style-carrying text for golden files: `[violet b]text[/]`; unstyled text is written as is.
function toMarkup(lines) {
  return lines.map((line) => line.map((sp) => {
    const tags = [];
    if (sp.fg) tags.push(sp.fg);
    if (sp.bg) tags.push('bg:' + sp.bg);
    if (sp.b) tags.push('b');
    if (sp.inv) tags.push('inv');
    if (sp.sel) tags.push('sel');
    return tags.length ? `[${tags.join(' ')}]${sp.t}[/]` : sp.t;
  }).join('')).join('\n') + '\n';
}

// ---- text safety -------------------------------------------------------------------------------
// Everything taken from a lease file must go through sanitize() before it is printed: a crafted purpose or branch
// must not be able to send terminal commands (title changes, cursor moves, hyperlinks) or reorder the text.
const RE_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g; // ESC ] ... BEL or ESC \
const RE_STR = /\u001b[P_^X][^\u001b]*(?:\u001b\\)?/g; // DCS, APC, PM, SOS strings
const RE_CSI = /\u001b\[[0-?]*[ -/]*[@-~]?/g;
const RE_ESC = /\u001b[\s\S]?/g;
const RE_SPACEY = /[\t\n\r\u2028\u2029]/g;
const RE_CTRL = /[\u0000-\u001f\u007f-\u009f­]/g;
// Bidirectional controls, zero-width characters, byte-order mark and the invisible "tag" block. This range also
// removes the zero-width joiner and non-joiner (U+200C/U+200D): a joined emoji sequence therefore shows as its
// separate emoji, which is a deliberate trade for never letting invisible characters through.
const RE_INVISIBLE = /[؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿￹-￻]|[\u{e0000}-\u{e007f}]/gu;

function sanitize(value, max = 200) {
  let s;
  if (typeof value === 'string') s = value;
  else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') s = String(value);
  else return '';
  s = s.replace(RE_OSC, '').replace(RE_STR, '').replace(RE_CSI, '').replace(RE_ESC, '')
    .replace(RE_SPACEY, ' ').replace(RE_CTRL, '').replace(RE_INVISIBLE, '');
  const cps = Array.from(s);
  if (cps.length > max) return cps.slice(0, Math.max(0, max - 1)).join('') + '…';
  return s;
}

// JSON.stringify leaves DEL, C1 controls, bidi marks, line separators and tag characters as raw bytes, and some
// terminals act on them. Write them as \uXXXX escapes; the parsed value is unchanged.
const RE_JSON_RAW = /[\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]|[\u{e0000}-\u{e007f}]/gu;
function jsonSafe(text) {
  return String(text).replace(RE_JSON_RAW, (ch) => {
    const cp = ch.codePointAt(0);
    const u = (n) => '\\u' + n.toString(16).padStart(4, '0');
    if (cp > 0xffff) { const c = cp - 0x10000; return u(0xd800 + (c >> 10)) + u(0xdc00 + (c & 0x3ff)); }
    return u(cp);
  });
}

// ---- display width -----------------------------------------------------------------------------
// Cells a code point takes on screen: 0 for combining marks and controls, 2 for East Asian wide and emoji, 1
// otherwise. Ambiguous-width characters count as 1.
const WIDE = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
];
const RE_EMOJI_WIDE = /\p{Emoji_Presentation}/u;
const RE_MARK = /\p{M}/u;
function cpWidth(cp, ch) {
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x300) return 1;
  if (RE_MARK.test(ch) || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfeff || (cp >= 0x1160 && cp <= 0x11ff)) return 0;
  for (const [a, b] of WIDE) if (cp >= a && cp <= b) return 2;
  if (cp >= 0x231a && RE_EMOJI_WIDE.test(ch)) return 2;
  return 1;
}
// Split into user-visible characters (an emoji with its modifiers, a letter with its accents, a flag).
const SEGMENTER = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
function clusters(s) {
  s = String(s);
  if (!SEGMENTER) return Array.from(s);
  const out = [];
  for (const { segment } of SEGMENTER.segment(s)) out.push(segment);
  return out;
}
// Cells one cluster takes: its first character decides, except that an emoji presentation selector (U+FE0F), a
// flag (two regional indicators) and a keycap sequence make it 2. Skin tones and joined parts add nothing.
function clusterWidth(c) {
  const first = c.codePointAt(0);
  const w = cpWidth(first, String.fromCodePoint(first));
  if (w === 0) return 0;
  if (c.length > 1) {
    if (first >= 0x1f1e6 && first <= 0x1f1ff) return 2;
    if (c.includes('\ufe0f')) return 2;
  }
  return w;
}
function width(s) {
  s = String(s);
  if (/^[\x20-\x7e]*$/.test(s)) return s.length;
  let w = 0;
  for (const c of clusters(s)) w += clusterWidth(c);
  return w;
}
// Cut to at most `w` cells, ending in an ellipsis when something was cut. Never splits a cluster.
function truncate(s, w) {
  s = String(s);
  if (w <= 0) return '';
  if (width(s) <= w) return s;
  let out = ''; let used = 0;
  for (const c of clusters(s)) {
    const cw = clusterWidth(c);
    if (used + cw > w - 1) break;
    out += c; used += cw;
  }
  return out + '…';
}
// Pad with spaces to exactly `w` cells (cuts first when too long). align: 'left' | 'right'.
function pad(s, w, align = 'left') {
  const t = truncate(s, w);
  const gap = ' '.repeat(Math.max(0, w - width(t)));
  return align === 'right' ? gap + t : t + gap;
}

// ---- glyphs ------------------------------------------------------------------------------------
const GLYPHS = Object.freeze({
  unicode: {
    dot: '●', dotOff: '◌', mark: '▎', queue: '≡', warn: '⚠', wait: '░', fill: '█', up: '↑', down: '↓',
    blocks: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'], // 1/8 .. 8/8 high
    partial: ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'], // 0/8 .. 7/8 wide
    box: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' }, ellipsis: '…', middot: '·',
  },
  ascii: {
    dot: '*', dotOff: 'o', mark: '>', queue: '=', warn: '!', wait: '.', fill: '#', up: '^', down: 'v',
    blocks: ['_', '.', ':', '-', '=', '+', '*', '#'],
    partial: ['', '|', '|', '|', '|', '|', '|', '|'],
    box: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' }, ellipsis: '~', middot: '-',
  },
});
// The ASCII set is for the Linux text console (its font lacks the block glyphs) and for tests.
function glyphSet(env = {}) { return env.TERM === 'linux' ? GLYPHS.ascii : GLYPHS.unicode; }

module.exports = {
  TOKENS, ROLES, SGR16, INDEX256, tokenOf, detectColorLevel, inkColor,
  S, toAnsi, toPlain, toMarkup, sanitize, jsonSafe, clusters, clusterWidth, width, truncate, pad, GLYPHS, glyphSet, hexToRgb, nearest256,
};
