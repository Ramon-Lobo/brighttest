'use strict';

// The pure core of `brighttest device watch`: turns a lease Board (lib/device-lease-view.js) into what a screen
// shows, handles keys, and prints the non-interactive forms. Nothing here touches the terminal, the lease
// folder or the network: every function takes its inputs (board, ui state, size, clock) and returns data or
// strings, so it is tested with fixed boards and golden files.
//
//   renderModel(board, ui, size, now)   what every pane shows, as styled lines (the view model)
//   renderFrame(board, ui, size, now)   the whole screen as exactly `rows` styled lines (reference rendering)
//   reduce(ui, key, board)              key handling: { ui, effects }
//   inkKeyName(input, key)              maps a layout library's key event to the reducer's key names
//   renderStatic / renderOnce / renderPlainBlock / renderJson     the non-interactive outputs
//   chooseMode, parseInterval, runWatch   mode choice and the plain loop (the live screen is a separate module)
//
// Every string that comes from the board goes through sanitize() first, so a crafted lease file cannot send
// terminal commands to the screen.

const T = require('./tui');
const { S, sanitize, width, truncate, pad } = T;

const MIN_COLS = 60;
const MIN_ROWS = 16;
const SIDE_COLS = 120;
const MAX_RUNS = 200;
const DEFAULT_INTERVAL_MS = 2000;
const MIN_INTERVAL_MS = 500;
const MAX_INTERVAL_MS = 3600000; // one hour; a larger value would overflow the timer

// ---- small formatting helpers ------------------------------------------------------------------
const clean = (v, max) => sanitize(v, max);
function fmtDur(ms) {
  if (ms == null || !Number.isFinite(ms)) return '-';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}
// Short duration for tight columns: 45s, 4m12s, 1h05m.
const two = (n) => String(n).padStart(2, '0');
function clock(ms, utc) {
  if (!Number.isFinite(ms)) return '--:--:--';
  const d = new Date(ms);
  return utc ? `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`
    : `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
function hm(isoText, utc) {
  const t = Date.parse(isoText);
  return Number.isFinite(t) ? clock(t, utc).slice(0, 5) : '--:--';
}
const intervalText = (ms) => (ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`);

// Board times are measured at board.at; ages grow by however long ago the board was made.
function boardClock(board, now) {
  const at = Date.parse(board && board.at);
  const base = Number.isFinite(at) ? at : now;
  return { at: base, drift: Math.max(0, now - base) };
}
const aged = (ms, drift) => (Number.isFinite(ms) ? ms + drift : null);

// ---- ui state ----------------------------------------------------------------------------------
function initialUi(size = {}, flags = {}, board = null) {
  return syncSelection({
    focus: 'devices', selected: null, selectedIndex: 0, detailOpen: false, runCursor: 0, runScroll: 0,
    help: false, paused: false, pausedAt: null, all: !!flags.all, intervalMs: flags.intervalMs || DEFAULT_INTERVAL_MS,
    cols: size.cols || 80, rows: size.rows || 24,
  }, board);
}
// When nothing is selected yet, select the first device (so the selection is an id from the start, not a row
// number that drifts when the list changes). Call it with each new board.
function syncSelection(ui, board) {
  const devs = (board && board.devices) || [];
  if (ui.selected == null && devs.length) return { ...ui, selected: devs[0].id, selectedIndex: 0 };
  return ui;
}
// Keep the run cursor and scroll inside the run list after the size or the board changed.
function clampRuns(ui, board) {
  const devs = (board && board.devices) || [];
  const idx = selectedIndexOf(board, ui);
  if (idx < 0) return ui.runCursor || ui.runScroll ? { ...ui, runCursor: 0, runScroll: 0 } : ui;
  const total = Math.min((devs[idx].runs || []).length, MAX_RUNS);
  const m = renderModel(board, ui, { cols: ui.cols, rows: ui.rows }, Date.parse(board.at) || 0, { utc: true });
  const visible = m.layout === 'tooSmall' ? 0 : m.detail.runs.visible;
  const cursor = Math.max(0, Math.min(ui.runCursor || 0, Math.max(0, total - 1)));
  let scroll = Math.max(0, Math.min(ui.runScroll || 0, Math.max(0, total - Math.max(visible, 1))));
  if (visible > 0) { if (cursor < scroll) scroll = cursor; else if (cursor >= scroll + visible) scroll = cursor - visible + 1; }
  return cursor === ui.runCursor && scroll === ui.runScroll ? ui : { ...ui, runCursor: cursor, runScroll: scroll };
}
function resize(ui, size, board = null) {
  const next = { ...ui, cols: size.cols, rows: size.rows };
  return board ? clampRuns(next, board) : next;
}

// The selected device is remembered by id; if it vanished, the nearest row takes over.
function selectedIndexOf(board, ui) {
  const devs = (board && board.devices) || [];
  if (!devs.length) return -1;
  const i = devs.findIndex((d) => d.id === ui.selected);
  if (i >= 0) return i;
  return Math.max(0, Math.min(ui.selectedIndex || 0, devs.length - 1));
}

// ---- roles and outcomes ------------------------------------------------------------------------
const stateRole = (state) => (state === 'held' || state === 'free' || state === 'stale' || state === 'corrupt' ? state : 'unknown');
function runOutcome(run) {
  switch (run.ended) {
    case 'released': return !Number.isFinite(run.exitCode) || run.exitCode === 0
      ? { role: 'runOk', text: 'ok' } : { role: 'runFailed', text: `exit ${run.exitCode}` };
    case 'running': return { role: 'running', text: 'running' };
    case 'lost': return { role: 'runFailed', text: 'lost' };
    case 'reclaimed': return { role: 'runFailed', text: 'reclaimed' };
    case 'forced': return { role: 'runFailed', text: 'forced' };
    case 'timeout': return { role: 'runFailed', text: 'gave up' };
    default: return { role: 'meta', text: '?' };
  }
}
function runHoldMs(run, now) {
  if (run.ended === 'running') {
    const s = Date.parse(run.startedAt);
    return Number.isFinite(s) ? Math.max(0, now - s) : null;
  }
  return Number.isFinite(run.heldMs) ? run.heldMs : null;
}

// ---- line helpers ------------------------------------------------------------------------------
const lineWidth = (line) => line.reduce((n, sp) => n + width(sp.t), 0);
// Cut a line to `w` cells (ellipsis on the last span that overflows) and pad to exactly `w` with `bg`.
function fitLine(line, w, bg) {
  const out = [];
  let used = 0;
  for (let i = 0; i < line.length; i++) {
    const sp = line[i];
    const sw = width(sp.t);
    if (used + sw <= w) { out.push(sp); used += sw; continue; }
    const rest = w - used;
    if (rest > 0) {
      const cut = truncate(sp.t, rest);
      out.push({ ...sp, t: cut });
      used += width(cut); // a wide character at the cut can leave one cell free; the fill below covers it
    }
    break;
  }
  if (used < w) {
    const last = out[out.length - 1];
    const fill = { t: ' '.repeat(w - used) };
    const b = (last && last.bg) || bg;
    if (b) fill.bg = b;
    if (last && last.sel) fill.sel = true;
    out.push(fill);
  }
  return out;
}
const paint = (line, bg) => line.map((sp) => (sp.bg ? sp : { ...sp, bg }));
// Spans covering display columns [from, to) of a line, padded with spaces where a wide character is cut.
function sliceLine(line, from, to) {
  const out = [];
  let col = 0;
  for (const sp of line) {
    let text = '';
    for (const ch of T.clusters(sp.t)) {
      const cw = T.clusterWidth(ch);
      const a = col; const b = col + cw;
      col = b;
      if (b <= from || a >= to) continue;
      if (a >= from && b <= to) text += ch;
      else text += ' '.repeat(Math.min(b, to) - Math.max(a, from));
    }
    if (text) out.push({ ...sp, t: text });
  }
  return out;
}
const joinLines = (a, b) => a.concat(b);

// ---- layout ------------------------------------------------------------------------------------
function layoutOf(size, listWanted) {
  const { cols, rows } = size;
  if (!(cols >= MIN_COLS && rows >= MIN_ROWS)) return { kind: 'tooSmall', cols, rows };
  const body = rows - 2;
  if (cols >= SIDE_COLS) {
    const lw = Math.floor(cols * 0.45);
    return { kind: 'side', cols, rows, body, list: { w: lw, h: body }, detail: { w: cols - lw, h: body } };
  }
  const lh = Math.max(5, Math.min(Math.floor(body / 2), listWanted));
  return { kind: 'stacked', cols, rows, body, list: { w: cols, h: lh }, detail: { w: cols, h: body - lh } };
}

// ---- device list -------------------------------------------------------------------------------
function deviceRow(d, cols, ctx, selected, focused) {
  const { drift, G, level } = ctx;
  const role = stateRole(d.state);
  const holder = d.holder;
  const stateWord = d.state === 'stale' ? 'STALE' : d.state;
  const held = d.state === 'free' || !holder ? '-' : fmtDur(aged(holder.heldMs, drift));
  const nq = d.queueLength || 0;
  const reach = d.reach && d.reach.state;
  const reachSpan = reach === 'up' ? S('up', 'up') : reach === 'unreachable' ? S(`${G.warn} unreach`, 'unreachable') : S(G.middot, 'unknown');
  const sel = selected ? { bg: 'panel2', sel: true } : {};
  const mark = selected ? S(level === 'none' ? '>' : G.mark, focused ? 'violet' : 'violetDim', sel) : S(' ', null, sel);
  const sp = (t, fg, extra) => S(t, fg, { ...sel, ...(extra || {}) });
  const parts = [
    mark, sp(' '), sp(G.dot, ROLES_OF(role)), sp(' '), sp(pad(clean(d.label, 40), cols.L), 'text'), sp(' '),
    sp(pad(stateWord, 7), ROLES_OF(role), { b: selected }), sp(' '),
  ];
  if (cols.H > 0) parts.push(sp(pad(holder ? clean(holder.agent, 40) : '-', cols.H), holder ? 'text' : 'haze'), sp(' '));
  parts.push(sp(pad(held, 6, 'right'), 'haze'), sp(' '),
    sp(pad(nq ? `${G.queue}${nq}` : `${G.queue}0`, 3, 'right'), nq ? 'queued' : 'haze'), sp(' '), { ...reachSpan, ...sel });
  return parts;
}
const ROLES_OF = (role) => role; // a role name is a valid style name; kept as a function for readability

function runStrip(d, innerW, ctx) {
  const { now, G } = ctx;
  const runs = (d && d.runs) || [];
  const label = ' runs ';
  const room = Math.max(0, Math.min(20, innerW - label.length - 1));
  const shown = runs.slice(0, room).reverse(); // oldest on the left
  if (!shown.length) return [S(' runs ', 'haze'), S('none yet', 'haze')];
  const holds = shown.map((r) => runHoldMs(r, now) || 0);
  const max = Math.max(1, ...holds);
  const line = [S(label, 'haze')];
  shown.forEach((r, i) => {
    const idx = Math.max(0, Math.min(7, Math.ceil((holds[i] / max) * 8) - 1));
    line.push(S(G.blocks[idx], runOutcome(r).role));
  });
  const tail = `  (${clean(d.label, 20)}, last ${shown.length})`;
  if (label.length + shown.length + tail.length <= innerW) line.push(S(tail, 'haze'));
  return line;
}

function buildList(board, ui, size, lay, ctx) {
  const innerW = lay.list.w - 2; const innerH = lay.list.h - 2;
  const devs = board.devices || [];
  const pools = board.pools || [];
  const selIdx = selectedIndexOf(board, ui);
  const focused = ui.focus === 'devices';
  const maxLabel = devs.reduce((m, d) => Math.max(m, width(clean(d.label, 40))), 5);
  const L = Math.max(5, Math.min(12, maxLabel));
  const fixed = 1 + 1 + 1 + 1 + L + 1 + 7 + 1 + 6 + 1 + 3 + 1 + 9; // without the holder column
  let H = innerW - fixed - 1;
  if (H < 6) H = 0; else H = Math.min(H, 20);
  const cols = { L, H };
  const rows = devs.map((d, i) => deviceRow(d, cols, ctx, i === selIdx, focused));
  pools.forEach((p) => {
    const n = p.queueLength || 0;
    rows.push([S(' '), S(' '), S(ctx.G.dotOff, 'unknown'), S(' '), S(pad('pool', L), 'text'), S(' '),
      S(`line ${n}`, n ? 'queued' : 'haze'), S(p.size ? ` (${p.size} devices)` : '', 'haze')]);
  });
  const extras = [];
  if (innerH >= 3) extras.push(runStrip(devs[selIdx], innerW, ctx));
  const hidden = board.hidden && board.hidden.keys ? board.hidden.keys : 0;
  if (innerH >= 4 && (hidden || ui.all)) {
    extras.push(ui.all ? [S(' showing all keys', 'haze'), S(' · a: hide', 'haze')]
      : [S(` ${hidden} hidden (loopback or idle > 7d)`, 'haze'), S(' · a: all', 'haze')]);
  }
  const cap = Math.max(1, innerH - extras.length);
  const start = Math.max(0, Math.min(selIdx - Math.floor(cap / 2), rows.length - cap));
  let lines = rows.slice(start, start + cap).map((l) => fitLine(l, innerW));
  if (!devs.length && !pools.length) lines = [[S(' no devices known yet', 'haze')]];
  while (lines.length < innerH - extras.length) lines.push([]);
  lines = lines.concat(extras).slice(0, innerH).map((l) => fitLine(l, innerW));
  return { title: [S(' Devices ', ui.focus === 'devices' ? 'text' : 'haze', { b: true })], lines, selectedIndex: selIdx, visibleRows: cap, wanted: rows.length + 3 };
}

// ---- detail pane -------------------------------------------------------------------------------
function statsText(st) {
  if (!st) return '';
  return `${st.window || '24h'}: ${st.runs || 0} · hold p50 ${fmtDur(st.medianHoldMs)} p90 ${fmtDur(st.p90HoldMs)}`
    + ` · wait p50 ${fmtDur(st.medianWaitMs)} · max line ${st.maxQueue || 0}`;
}

// One horizontal bar: wait part (amber, light blocks) then hold part (outcome color, eighth-block precision),
// scaled so the longest run fills `barW`. Any nonzero run shows at least one cell.
function barSpans(waitMs, holdMs, scaleMs, barW, role, G) {
  if (barW <= 0) return [];
  const w = Math.max(0, waitMs || 0); const h = Math.max(0, holdMs || 0);
  let waitCells = scaleMs > 0 ? Math.round((w / scaleMs) * barW) : 0;
  if (w > 0 && waitCells === 0) waitCells = 1;
  let holdEighths = scaleMs > 0 ? Math.round((h / scaleMs) * barW * 8) : 0;
  if (h > 0 && holdEighths === 0 && waitCells === 0) holdEighths = 8;
  if (waitCells > barW) waitCells = barW;
  let holdCells = Math.floor(holdEighths / 8); let rem = holdEighths % 8;
  if (waitCells + holdCells + (rem ? 1 : 0) > barW) { holdCells = Math.max(0, barW - waitCells); rem = 0; }
  const out = [];
  if (waitCells) out.push(S(G.wait.repeat(waitCells), 'waitBar'));
  if (holdCells) out.push(S(G.fill.repeat(holdCells), role));
  if (rem) out.push(S(G.partial[rem], role));
  const used = waitCells + holdCells + (rem ? 1 : 0);
  if (used < barW) out.push(S(' '.repeat(barW - used)));
  return out;
}

function buildDetail(board, ui, size, lay, ctx, dev) {
  const innerW = lay.detail.w - 2; const innerH = lay.detail.h - 2;
  const { drift, now, utc, G } = ctx;
  const focused = ui.focus === 'detail';
  const kv = (k, v, vr) => [S(k + ' ', 'haze'), S(v, vr || 'text')];
  if (!dev) {
    const lines = [[S(' nothing selected', 'haze')]].map((l) => fitLine(l, innerW));
    while (lines.length < innerH) lines.push([]);
    return { title: [S(' Detail ', focused ? 'text' : 'haze', { b: true })], lines: lines.slice(0, innerH), runs: { total: 0, scroll: 0, visible: 0, cursor: 0 } };
  }
  const h = dev.holder;
  const role = stateRole(dev.state);
  const title = [S(' ' + clean(dev.label, 30), 'text', { b: true })];
  if (dev.state === 'held' && h) title.push(S(` · held by ${clean(h.agent, 24)} for ${fmtDur(aged(h.heldMs, drift))} `, 'held'));
  else if (dev.state === 'stale' && h) title.push(S(` · STALE: ${clean(h.staleReason, 24)} `, 'stale'));
  else if (dev.state === 'corrupt') title.push(S(' · lease file unreadable ', 'corrupt'));
  else title.push(S(' · free ', 'free'));

  const top = [];
  if (h) {
    const f = [S(' ')].concat(kv('purpose', clean(h.purpose, 60)));
    if (h.deadline) f.push(S('   '), ...kv('deadline', hm(h.deadline, utc)));
    if (h.branch) f.push(S('   '), ...kv('branch', clean(h.branch, 40)));
    if (h.foreign) f.push(S('   '), ...kv('host', clean(h.hostname, 30), 'queued'));
    top.push(f);
  } else {
    top.push([S(' '), S(dev.state === 'corrupt' ? clean(dev.error, 80) || 'holder file unreadable' : 'idle: nobody holds this device', dev.state === 'corrupt' ? 'corrupt' : 'haze')]);
  }
  const q = dev.queue || [];
  const reach = dev.reach || {};
  const showReach = innerH >= 9;
  const stats = [S(' Runs (', 'haze'), S(statsText(dev.stats), 'haze'), S(')', 'haze')];
  const fixedCount = 1 + (showReach ? 1 : 0) + 1; // facts, reach, stats heading
  const cap = Math.max(1, Math.min(5, innerH - fixedCount - 2));
  const qLines = [];
  if (!q.length) qLines.push([S(' line  ', 'haze'), S('empty', 'haze')]);
  else {
    const shown = q.length > cap ? q.slice(0, Math.max(1, cap - 1)) : q;
    shown.forEach((t, i) => {
      const lead = S(i === 0 ? ' line  ' : '       ', 'haze');
      if (t.dead) { qLines.push([lead, S('dead ticket (will be swept)', 'stale')]); return; }
      qLines.push([lead, S(`#${t.pos} `, 'queued'), S(clean(t.agent, 24), 'text'), S(` "${clean(t.purpose, 40)}"`, 'text'),
        S(`  waiting ${fmtDur(aged(t.waitingMs, drift))}`, 'queued'), S(t.etaMs != null ? `  eta ~${fmtDur(t.etaMs)}` : '', 'haze')]);
    });
    if (q.length > shown.length && cap > 1) qLines.push([S('       ', 'haze'), S(`+${q.length - shown.length} more`, 'haze')]);
  }
  top.push(...qLines);
  if (showReach) {
    const rs = reach.state === 'up' ? S('up', 'up') : reach.state === 'unreachable' ? S(`${G.warn} unreachable`, 'unreachable') : S(reach.idle ? 'idle, not probed' : 'not probed', 'unknown');
    const r = [S(' reach ', 'haze'), rs];
    if (reach.at) r.push(S(`  checked ${hm(reach.at, utc)}`, 'haze'));
    if (reach.note) r.push(S('  ' + clean(reach.note, 60), 'queued'));
    top.splice(1, 0, r);
  }
  top.push(stats);

  const runs = (dev.runs || []).slice(0, MAX_RUNS);
  const visible = Math.max(0, innerH - top.length);
  const maxScroll = Math.max(0, runs.length - visible);
  const scroll = Math.max(0, Math.min(ui.runScroll || 0, maxScroll));
  const cursor = Math.max(0, Math.min(ui.runCursor || 0, Math.max(0, runs.length - 1)));
  const win = runs.slice(scroll, scroll + visible);

  // Run row columns: time, who, bar, wait, hold, end.
  const tailW = 1 + 6 + 1 + 6 + 1 + 9; // wait, hold, end with spacers
  const rest = innerW - 1 - 6 - tailW;
  let barW = rest >= 26 ? Math.max(6, Math.min(24, Math.floor(rest * 0.4))) : 0;
  const nameW = Math.max(6, rest - barW - (barW ? 1 : 0));
  if (nameW + barW + 7 + tailW > innerW) barW = 0;
  const holds = win.map((r) => runHoldMs(r, now));
  const scaleMs = Math.max(1, ...win.map((r, i) => (r.waitedMs || 0) + (holds[i] || 0)));
  const runLines = win.map((r, i) => {
    const isCur = focused && scroll + i === cursor;
    const sel = isCur ? { bg: 'panel2', sel: true } : {};
    const o = runOutcome(r);
    const sp = (t, fg, extra) => S(t, fg, { ...sel, ...(extra || {}) });
    const out = [sp(isCur ? (ctx.level === 'none' ? '>' : G.mark) : ' ', 'violet'), sp(hm(r.startedAt, utc) + ' ', 'haze'),
      sp(pad(`${clean(r.agent, 24)} ${clean(r.purpose, 40)}`, nameW), 'text'), sp(' ')];
    if (barW) out.push(...barSpans(r.waitedMs, holds[i], scaleMs, barW, o.role, G).map((b) => ({ ...b, ...sel })), sp(' '));
    out.push(sp(pad(fmtDur(r.waitedMs), 6, 'right'), 'haze'), sp(' '), sp(pad(fmtDur(holds[i]), 6, 'right'), 'text'), sp(' '), sp(pad(o.text, 9), o.role));
    return out;
  });
  if (!runs.length && visible > 0) runLines.push([S(' no runs recorded yet', 'haze')]);
  const lines = top.concat(runLines).slice(0, innerH).map((l) => fitLine(l, innerW));
  while (lines.length < innerH) lines.push(fitLine([], innerW));
  void role;
  return { title, lines, runs: { total: runs.length, scroll, visible, cursor } };
}

// ---- header, footer, help ----------------------------------------------------------------------
function buildHeader(board, ui, size, ctx) {
  const left = [S(' brighttest ', 'violet', { b: true }), S(' device watch', 'text')];
  const when = ui.paused
    ? S(`PAUSED ${clock(Date.parse(ui.pausedAt) || ctx.now, ctx.utc)}`, 'amber', { b: true })
    : S(clock(ctx.now, ctx.utc), 'haze');
  const interval = S(intervalText(ui.intervalMs || DEFAULT_INTERVAL_MS), 'haze');
  const dir = clean(board.dir, 60); const machine = clean(board.machine, 30);
  const err = board.error ? [S('  ' + clean(board.error, 50), 'fail')] : [];
  const mid = (txt) => S(txt, 'haze');
  const options = [
    [mid(`lease dir ${dir} · this machine (${machine}) · `), when, mid(' · '), interval],
    [mid(`lease dir ${dir} · `), when, mid(' · '), interval],
    [when, mid(' · '), interval],
    [when],
  ];
  let right = options[options.length - 1];
  for (const o of options) { if (lineWidth(left) + lineWidth(err) + lineWidth(o) + 3 <= size.cols) { right = o; break; } }
  const gap = Math.max(1, size.cols - lineWidth(left) - lineWidth(err) - lineWidth(right) - 1);
  return fitLine(left.concat(err, [S(' '.repeat(gap))], right, [S(' ')]), size.cols, 'panel2').map((s) => ({ ...s, bg: 'panel2' }));
}

function buildFooter(board, ui, size, ctx) {
  const hints = size.cols < 80
    ? [['↑↓', 'select'], ['tab', 'pane'], ['p', 'pause'], ['?', 'help'], ['q', 'quit']]
    : [['↑↓', 'select'], ['enter', 'detail'], ['tab', 'pane'], ['a', 'all'], ['p', 'pause'], ['r', 'refresh'], ['?', 'help'], ['q', 'quit']];
  const left = [S(' ')];
  hints.forEach(([k, v], i) => { left.push(S(k, 'text'), S(' ' + v + (i < hints.length - 1 ? '  ' : ''), 'haze')); });
  const times = (board.devices || []).map((d) => Date.parse(d.reach && d.reach.at)).filter(Number.isFinite);
  const right = times.length ? [S(`reach: ${clock(Math.max(...times), ctx.utc)} `, 'haze')] : [];
  const gap = size.cols - lineWidth(left) - lineWidth(right);
  const line = gap >= 1 ? left.concat([S(' '.repeat(gap))], right) : left;
  return fitLine(line, size.cols);
}

const HELP_KEYS = [
  ['↑ ↓  k j', 'move selection'], ['PgUp PgDn  g G', 'page, first, last'], ['enter  →  l', 'open detail'],
  ['←  h', 'back to the device list'], ['tab  shift-tab', 'switch pane'], ['a', 'show or hide all keys'],
  ['p', 'pause or resume'], ['r', 'refresh now'], ['?', 'this help'], ['esc', 'close help, back, then quit'], ['q  ctrl-c', 'quit'],
];
function buildHelp() {
  return HELP_KEYS.map(([k, v]) => [S(' ' + pad(k, 16), 'violet'), S(v, 'text')]);
}

// ---- the view model ----------------------------------------------------------------------------
// renderModel(board, ui, size, now) -> { layout, cols, rows, header, footer, devices, detail, help, tooSmall,
// selected }. Lines are styled spans already cut to their pane's inner width; borders and backgrounds are added
// by whoever draws (renderFrame here, the live screen elsewhere).
function renderModel(board, ui, size, now, opts = {}) {
  const b = board && Array.isArray(board.devices) ? board : { devices: [], pools: [], hidden: {}, ...(board || {}) };
  const level = opts.level || 'truecolor';
  const lay0 = layoutOf(size, 1000);
  const eff = ui.paused && Number.isFinite(Date.parse(ui.pausedAt)) ? Date.parse(ui.pausedAt) : now;
  const { drift } = boardClock(b, eff);
  const ctx = { now: eff, drift, utc: !!opts.utc, G: opts.ascii ? T.GLYPHS.ascii : T.GLYPHS.unicode, level };
  const base = { cols: size.cols, rows: size.rows, help: ui.help ? buildHelp() : null, tooSmall: null };
  if (lay0.kind === 'tooSmall') {
    return { ...base, layout: 'tooSmall', header: null, footer: null, devices: null, detail: null, selected: null,
      tooSmall: [S(`terminal too small (need ${MIN_COLS}x${MIN_ROWS})`, 'haze')] };
  }
  const wanted = (b.devices.length + (b.pools || []).length) + 2 + 2;
  const lay = layoutOf(size, wanted);
  const selIdx = selectedIndexOf(b, ui);
  const dev = selIdx >= 0 ? b.devices[selIdx] : null;
  const devices = buildList(b, ui, size, lay, ctx);
  const detail = buildDetail(b, ui, size, lay, ctx, dev);
  return {
    ...base, layout: lay.kind, lay, header: buildHeader(b, { ...ui }, size, ctx), footer: buildFooter(b, ui, size, ctx),
    devices, detail, selected: dev ? dev.id : null,
  };
}

// ---- full-screen reference rendering -----------------------------------------------------------
function boxed(title, innerLines, w, h, focused, G) {
  const B = G.box;
  const bc = focused ? 'violet' : 'line';
  const inner = w - 2;
  let titleSpans = title;
  const room = inner - 1;
  if (lineWidth(titleSpans) > room) titleSpans = fitLine(titleSpans, room);
  const used = lineWidth(titleSpans);
  const top = [S(B.tl, bc), ...titleSpans, S(B.h.repeat(Math.max(0, inner - used)), bc), S(B.tr, bc)];
  const out = [paint(top, 'panel')];
  for (let i = 0; i < h - 2; i++) {
    const l = innerLines[i] || [];
    out.push([S(B.v, bc, { bg: 'panel' }), ...paint(fitLine(l, inner, 'panel'), 'panel'), S(B.v, bc, { bg: 'panel' })]);
  }
  out.push(paint([S(B.bl + B.h.repeat(inner) + B.br, bc)], 'panel'));
  return out;
}

function renderFrame(board, ui, size0, now, opts = {}) {
  const fin = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  const size = { cols: fin(size0 && size0.cols), rows: fin(size0 && size0.rows) };
  const m = renderModel(board, ui, size, now, opts);
  const { cols, rows } = size;
  const blank = () => fitLine([], cols, 'ink');
  let frame;
  if (m.layout === 'tooSmall') {
    frame = Array.from({ length: rows }, blank);
    const msg = fitLine(m.tooSmall, Math.min(cols, width('terminal too small (need 60x16)')), 'ink');
    const left = Math.max(0, Math.floor((cols - lineWidth(msg)) / 2));
    if (rows > 0) frame[Math.floor(rows / 2)] = paint(fitLine([S(' '.repeat(left)), ...msg], cols, 'ink'), 'ink');
    return frame;
  }
  const lay = m.lay;
  const G = opts.ascii ? T.GLYPHS.ascii : T.GLYPHS.unicode;
  const dBox = boxed(m.devices.title, m.devices.lines, lay.list.w, lay.list.h, ui.focus === 'devices', G);
  const tBox = boxed(m.detail.title, m.detail.lines, lay.detail.w, lay.detail.h, ui.focus === 'detail', G);
  const body = lay.kind === 'side' ? dBox.map((l, i) => joinLines(l, tBox[i])) : dBox.concat(tBox);
  frame = [paint(m.header, 'panel2'), ...body, paint(fitLine(m.footer, cols, 'ink'), 'ink')];
  while (frame.length < rows) frame.push(blank());
  frame = frame.slice(0, rows).map((l) => fitLine(l, cols, 'ink'));
  if (m.help) {
    const bw = Math.min(cols - 4, 52);
    const lines = [ ...m.help ];
    const bh = lines.length + 2;
    const top = Math.max(0, Math.floor((rows - bh) / 2)); const left = Math.floor((cols - bw) / 2);
    const B = G.box;
    const title = [S(' Keys ', 'text', { b: true })];
    const box = [
      [S(B.tl, 'violet'), ...title, S(B.h.repeat(Math.max(0, bw - 2 - lineWidth(title))), 'violet'), S(B.tr, 'violet')],
      ...lines.map((l) => [S(B.v, 'violet'), ...fitLine(l, bw - 2, 'panel2'), S(B.v, 'violet')]),
      [S(B.bl + B.h.repeat(bw - 2) + B.br, 'violet')],
    ].map((l) => paint(l, 'panel2'));
    box.forEach((over, i) => {
      const y = top + i;
      if (y >= rows) return;
      frame[y] = fitLine([...sliceLine(frame[y], 0, left), ...over, ...sliceLine(frame[y], left + bw, cols)], cols, 'ink');
    });
  }
  return frame;
}

// ---- keys --------------------------------------------------------------------------------------
// Names the reducer understands: up down left right enter tab shift-tab escape pageup pagedown home end ctrl-c
// ctrl-z, or a single printable character.
function inkKeyName(input, key) {
  const k = key || {};
  if (k.ctrl && input === 'c') return 'ctrl-c';
  if (k.ctrl && input === 'z') return 'ctrl-z';
  if (input === '\x03') return 'ctrl-c';
  if (k.upArrow) return 'up';
  if (k.downArrow) return 'down';
  if (k.leftArrow) return 'left';
  if (k.rightArrow) return 'right';
  if (k.return) return 'enter';
  if (k.escape) return 'escape';
  if (k.tab) return k.shift ? 'shift-tab' : 'tab';
  if (k.pageUp) return 'pageup';
  if (k.pageDown) return 'pagedown';
  if (k.home) return 'home';
  if (k.end) return 'end';
  if (k.ctrl || k.meta) return null;
  if (typeof input === 'string' && Array.from(input).length === 1 && input >= ' ' && input !== '\x7f') return input;
  return null;
}

// ---- reducer -----------------------------------------------------------------------------------
// reduce(ui, key, board) -> { ui, effects }. Effects: 'quit', 'snapshot' (take a new board), 'render'.
function reduce(ui, key, board, now = Date.now()) {
  const devs = (board && board.devices) || [];
  const next = { ...ui };
  const effects = [];
  const size = { cols: ui.cols, rows: ui.rows };

  if (key === 'ctrl-c') return { ui, effects: ['quit'] };
  if (key === 'ctrl-z') return { ui, effects: [] };
  if (ui.help) { // any other key closes the overlay
    next.help = false;
    return { ui: next, effects: ['render'] };
  }

  const selIdx = selectedIndexOf(board, ui);
  const metrics = () => {
    const m = renderModel(board, ui, size, Date.parse(board && board.at) || 0, { utc: true });
    return m.layout === 'tooSmall' ? { list: 1, runs: 0, total: 0 }
      : { list: m.devices.visibleRows, runs: m.detail.runs.visible, total: m.detail.runs.total };
  };
  const selectDevice = (i) => {
    if (!devs.length) return;
    const j = Math.max(0, Math.min(devs.length - 1, i));
    if (devs[j].id !== devs[selIdx].id) { next.runCursor = 0; next.runScroll = 0; }
    next.selected = devs[j].id; next.selectedIndex = j;
  };
  const moveRun = (to) => {
    const m = metrics();
    if (!m.total) return;
    const c = Math.max(0, Math.min(m.total - 1, to));
    next.runCursor = c;
    if (m.runs > 0) {
      if (c < next.runScroll) next.runScroll = c;
      else if (c >= next.runScroll + m.runs) next.runScroll = c - m.runs + 1;
    }
  };
  const move = (delta, mode) => {
    if (ui.focus === 'detail') {
      const m = metrics();
      const page = Math.max(1, m.runs - 1);
      moveRun(mode === 'first' ? 0 : mode === 'last' ? m.total - 1 : mode === 'page' ? ui.runCursor + delta * page : ui.runCursor + delta);
    } else {
      const page = Math.max(1, metrics().list - 1);
      selectDevice(mode === 'first' ? 0 : mode === 'last' ? devs.length - 1 : mode === 'page' ? selIdx + delta * page : selIdx + delta);
    }
  };
  // Keep the remembered selection in step with what is shown (the device may have moved or vanished).
  if (devs.length) { next.selected = devs[selIdx].id; next.selectedIndex = selIdx; }

  switch (key) {
    case 'up': case 'k': move(-1); break;
    case 'down': case 'j': move(1); break;
    case 'pageup': move(-1, 'page'); break;
    case 'pagedown': move(1, 'page'); break;
    case 'home': case 'g': move(0, 'first'); break;
    case 'end': case 'G': move(0, 'last'); break;
    case 'enter': case 'right': case 'l': next.focus = 'detail'; next.detailOpen = true; break;
    case 'left': case 'h': next.focus = 'devices'; next.detailOpen = false; break;
    case 'tab': case 'shift-tab': {
      const f = ui.focus === 'devices' ? 'detail' : 'devices';
      next.focus = f; next.detailOpen = f === 'detail'; break;
    }
    case 'a': next.all = !ui.all; if (!ui.paused) effects.push('snapshot'); break; // resuming takes the snapshot
    case 'p':
      next.paused = !ui.paused;
      next.pausedAt = next.paused ? ((board && board.at) || new Date(now).toISOString()) : null;
      if (!next.paused) effects.push('snapshot');
      break;
    case 'r': if (!ui.paused) effects.push('snapshot'); break; // a paused view stays frozen
    case '?': next.help = true; break;
    case 'escape':
      if (ui.focus === 'detail' || ui.detailOpen) { next.focus = 'devices'; next.detailOpen = false; break; }
      return { ui, effects: ['quit'] };
    case 'q': return { ui, effects: ['quit'] };
    default: return { ui, effects: [] };
  }
  const changed = Object.keys(next).some((k) => next[k] !== ui[k]);
  if (changed || effects.length) effects.push('render');
  return { ui: changed ? next : ui, effects };
}

// ---- non-interactive output --------------------------------------------------------------------
function renderStatic(board, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const utc = !!opts.utc;
  const { drift } = boardClock(board, now);
  const devs = board.devices || [];
  const out = [];
  const every = opts.live ? ` · every ${intervalText(opts.intervalMs || DEFAULT_INTERVAL_MS)} · Ctrl-C quits` : '';
  out.push([S('brighttest device watch', 'accent', { b: true }),
    S(` · lease dir ${clean(board.dir, 80)} (this machine, this user) · ${clock(now, utc)}${every}`, 'meta')]);
  if (board.error) out.push([S('error: ' + clean(board.error, 120), 'fail')]);
  if (!devs.length && !(board.pools || []).length) {
    out.push([S('No devices known yet. Run a lane or `brighttest device with` to create one.', 'meta')]);
  } else {
    const rows = devs.map((d) => {
      const h = d.holder;
      const reach = d.reach || {};
      const reachText = reach.state === 'up' ? 'up' : reach.state === 'unreachable' ? `unreachable (checked ${hm(reach.at, utc)})` : reach.idle ? 'idle, not probed' : 'not probed';
      return {
        d, label: clean(d.label, 20), state: d.state === 'stale' ? 'STALE' : d.state, holder: h ? clean(h.agent, 18) : '-',
        purpose: h ? clean(h.purpose, 28) : '-', held: d.state === 'free' || !h ? '-' : fmtDur(aged(h.heldMs, drift)),
        line: String(d.queueLength || 0), reachText, reachRole: reach.state === 'up' ? 'up' : reach.state === 'unreachable' ? 'unreachable' : 'unknown',
      };
    });
    const cw = (k, min) => Math.max(min, ...rows.map((r) => width(r[k])));
    const W = { label: cw('label', 6), state: cw('state', 5), holder: cw('holder', 6), purpose: cw('purpose', 7), held: cw('held', 3), line: 4 };
    out.push([S([pad('DEVICE', W.label), pad('STATE', W.state), pad('HOLDER', W.holder), pad('PURPOSE', W.purpose), pad('FOR', W.held), pad('LINE', W.line), 'REACH'].join('  '), 'meta', { b: true })]);
    for (const r of rows) {
      out.push([S(pad(r.label, W.label) + '  '), S(pad(r.state, W.state), stateRole(r.d.state)), S('  ' + pad(r.holder, W.holder) + '  ' + pad(r.purpose, W.purpose)
        + '  ' + pad(r.held, W.held) + '  ' + pad(r.line, W.line) + '  '), S(r.reachText, r.reachRole)]);
      if (r.d.reach && r.d.reach.note) out.push([S(`  note: ${clean(r.d.reach.note, 80)}`, 'queued')]);
    }
    for (const p of board.pools || []) {
      out.push([S(pad('pool', W.label) + '  ', null), S(pad('-', W.state)), S('  ' + pad('', W.holder + 2 + W.purpose + 2 + W.held) + '  ' + pad(String(p.queueLength || 0), W.line) + '  '), S(p.size ? `(${p.size} devices)` : '', 'meta')]);
    }
    out.push([]);
    for (const d of devs) {
      const q = (d.queue || []);
      if (q.length) {
        const parts = q.map((t) => (t.dead ? 'dead ticket (will be swept)'
          : `#${t.pos} ${clean(t.agent, 24)} "${clean(t.purpose, 40)}" waiting ${fmtDur(aged(t.waitingMs, drift))}${t.etaMs != null ? ` (eta ~${fmtDur(t.etaMs)})` : ''}`));
        out.push([S(`${clean(d.label, 20)} line: `, 'meta'), S(parts.join(' · '), 'queued')]);
      }
    }
    for (const d of devs) {
      const runs = d.runs || [];
      if (!runs.length) continue;
      out.push([S(`Recent runs (${clean(d.label, 20)}):`, 'meta')]);
      for (const r of runs) {
        const o = runOutcome(r);
        const hold = runHoldMs(r, now);
        out.push([S(`  ${hm(r.startedAt, utc)} ${clean(r.agent, 24)} "${clean(r.purpose, 40)}" waited ${fmtDur(r.waitedMs)}${r.ended === 'timeout' ? ' ' : ` held ${fmtDur(hold)} `}`), S(o.text, o.role)]);
      }
    }
    const withStats = devs.filter((d) => d.stats && d.stats.runs);
    if (withStats.length) {
      out.push([S('Last ' + (withStats[0].stats.window || '24h') + ': ', 'meta'), S(withStats.map((d) => `${clean(d.label, 20)} ${d.stats.runs} runs, hold median ${fmtDur(d.stats.medianHoldMs)} / p90 ${fmtDur(d.stats.p90HoldMs)}, wait median ${fmtDur(d.stats.medianWaitMs)}, longest line ${d.stats.maxQueue || 0}`).join(' · '))]);
    }
  }
  const hidden = board.hidden && board.hidden.keys ? board.hidden.keys : 0;
  if (hidden) out.push([S(`${hidden} hidden (loopback or idle > 7d); --all shows them`, 'meta')]);
  return out;
}
// --once: token foreground colors where the terminal supports them, no backgrounds; plain text otherwise.
function renderOnce(board, opts = {}) {
  const lines = renderStatic(board, opts);
  const level = opts.level || 'none';
  return (level === 'none' ? T.toPlain(lines) : T.toAnsi(lines, level)).join('\n') + '\n';
}
// One block of the plain loop (for tee and logs): never colored, never cleared.
function renderPlainBlock(board, opts = {}) {
  return T.toPlain(renderStatic(board, { ...opts, live: opts.live || 'plain' })).join('\n') + '\n';
}
function renderJson(board) { return T.jsonSafe(JSON.stringify(board, null, 2)) + '\n'; }

const INK_HINT = 'brighttest device watch: the interactive view needs the optional package ink; showing the plain live view. Install it with: npm i ink react';

// ---- mode choice and the plain loop ------------------------------------------------------------
// '2s', '500ms', '1.5s', or a bare number of milliseconds; at least 500 ms. Throws RangeError on bad input.
function parseInterval(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(String(text));
  if (!m) throw new RangeError(`invalid --interval: ${text} (use e.g. 2s or 500ms)`);
  const unit = (m[2] || 'ms').toLowerCase();
  const ms = Math.round(parseFloat(m[1]) * (unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 1));
  if (!(ms <= MAX_INTERVAL_MS)) throw new RangeError(`invalid --interval: ${text} (maximum is 1h)`);
  if (ms < MIN_INTERVAL_MS) throw new RangeError(`invalid --interval: ${text} (minimum is ${MIN_INTERVAL_MS}ms)`);
  return ms;
}
// Decided once at start. Old Windows consoles (build below 17763) cannot do the alternate screen: plain loop.
function chooseMode({ flags = {}, stdoutIsTTY = false, stdinIsTTY = false, env = {}, platform = process.platform, release = '' } = {}) {
  if (flags.json) return 'json';
  if (flags.once) return 'once';
  if (flags.plain || !stdoutIsTTY || !stdinIsTTY || env.TERM === 'dumb') return 'plain';
  if (platform === 'win32') {
    const build = Number((String(release).split('.')[2] || '').replace(/\D.*$/, ''));
    if (Number.isFinite(build) && build > 0 && build < 17763) return 'plain';
  }
  return 'tui';
}

// runWatch: json / once / plain loop, or the live screen, with injected io. Resolves to an exit code.
// The live screen needs the optional packages ink and react; they are imported only when the TUI mode is chosen
// (never for --json, --once, --plain or a non-TTY), and when they cannot be loaded one line goes to stderr and
// the plain loop runs instead. `tui` replaces the live screen (tests); `io.loadInk` replaces the loader.
//   io: { stdout, stderr, stdin, stdoutIsTTY, stdinIsTTY, env, platform, release, getColorDepth, now(), sleep(ms, signal), loadInk() }
async function runWatch({ view, flags = {}, io = {}, signal, tui = null } = {}) {
  const env = io.env || {};
  const nowFn = io.now || Date.now;
  const level = T.detectColorLevel({ env, isTTY: !!io.stdoutIsTTY, getColorDepth: io.getColorDepth });
  const snap = () => view.snapshot({ host: flags.host, all: !!flags.all, historyN: flags.tail || 10 });
  let mode = chooseMode({ flags, stdoutIsTTY: io.stdoutIsTTY, stdinIsTTY: io.stdinIsTTY, env, platform: io.platform, release: io.release });
  // --json and --once run one bounded probe pass (at most the probe timeout) before the board is read again.
  const probed = async () => {
    if (flags.noProbe || typeof view.settle !== 'function') return snap();
    snap(); // starts the probes
    try { await view.settle(); } catch { /* ignore */ }
    return snap();
  };
  if (mode === 'json') { io.stdout.write(renderJson(await probed())); return 0; }
  if (mode === 'once') { io.stdout.write(renderOnce(await probed(), { now: nowFn(), level, utc: flags.utc })); return 0; }
  if (mode === 'tui' && typeof tui === 'function') return tui({ view, flags, io, signal });
  if (mode === 'tui') {
    const loaded = await (io.loadInk || require('./tui-ink').loadInk)();
    if (!loaded.error) return require('./device-watch-ink').mountWatchApp({ ink: loaded.ink, React: loaded.React, view, flags, io });
    (io.stderr || process.stderr).write(`${INK_HINT}\n`);
  }
  mode = 'plain';
  const intervalMs = flags.intervalMs || DEFAULT_INTERVAL_MS;
  const sleep = io.sleep || ((ms, sig) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (sig) sig.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  }));
  let first = true;
  while (!(signal && signal.aborted)) {
    io.stdout.write((first ? '' : '\n') + renderPlainBlock(snap(), { now: nowFn(), intervalMs, utc: flags.utc }));
    first = false;
    await sleep(intervalMs, signal);
  }
  return 0;
}

module.exports = {
  MIN_COLS, MIN_ROWS, initialUi, resize, renderModel, renderFrame, reduce, inkKeyName,
  renderStatic, renderOnce, renderPlainBlock, renderJson, parseInterval, chooseMode, runWatch,
  syncSelection, clampRuns, fmtDur, INK_HINT, layoutOf, runOutcome, barSpans, selectedIndexOf,
};
