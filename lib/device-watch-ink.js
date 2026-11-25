'use strict';

// The live screen of `brighttest device watch`, drawn with ink. It holds no logic of its own: keys go through
// inkKeyName -> reduce, what is shown comes from renderModel (lib/device-watch.js), colors from lib/tui.js.
// ink and react are received as arguments (lib/tui-ink.js loads them), so this file loads without them and
// uses React.createElement instead of JSX (no build step).
//
//   createWatchApp({ ink, React, view, flags, io, level, ascii }) -> root component (a function component)
//   mountWatchApp({ ink, React, view, flags, io, proc }) -> Promise<exit code>

const W = require('./device-watch');
const T = require('./tui');

const SNAP_ERR_MAX = 80;

// The presentational part: a view model in, ink elements out. No hooks, so renderToString can draw it.
//   createWatchView({ ink, React, level, ascii }) -> function component ({ model, ui, size })
function createWatchView({ ink, React, level = 'none', ascii = false }) {
  const h = React.createElement;
  const { Box, Text } = ink;
  const noBg = level === '16' || level === 'none';
  const G = ascii ? T.GLYPHS.ascii : T.GLYPHS.unicode;

  const colorProps = (sp, defaultBg) => {
    const p = {};
    const fg = T.inkColor(sp.fg, level, 'fg');
    const bg = T.inkColor(sp.bg || defaultBg, level, 'bg');
    if (fg) p.color = fg;
    if (bg) p.backgroundColor = bg;
    if (sp.b) p.bold = true;
    if (sp.inv || (sp.sel && noBg)) p.inverse = true;
    return p;
  };
  // One styled line -> one row. `defaultBg` paints spans that have no background of their own (the pane color).
  const row = (line, key, defaultBg) => h(Box, { key, height: 1, flexShrink: 0 },
    h(Text, { wrap: 'truncate' }, ...line.map((sp, i) => h(Text, { key: i, ...colorProps(sp, defaultBg) }, sp.t))));
  const rows = (lines, defaultBg) => lines.map((l, i) => row(l, i, defaultBg));
  const text = (t, fg, bg, extra) => ({ t, fg, ...(bg ? { bg } : {}), ...(extra || {}) });

  // A pane: a hand-drawn top edge with the title (ink borders have no title), ink borders for the rest.
  function pane(m, which, lay, focused) {
    const part = lay[which];
    const bc = focused ? 'violet' : 'line';
    const title = m[which === 'list' ? 'devices' : 'detail'].title;
    const lines = m[which === 'list' ? 'devices' : 'detail'].lines;
    const used = title.reduce((n, sp) => n + T.width(sp.t), 0);
    const top = [text(G.box.tl, bc), ...title.map((sp) => ({ ...sp })), text(G.box.h.repeat(Math.max(0, part.w - 2 - used)), bc), text(G.box.tr, bc)];
    const bcolor = T.inkColor(bc, level, 'fg');
    return h(Box, { key: which, flexDirection: 'column', width: part.w, height: part.h, flexShrink: 0 },
      row(top, 'top', 'panel'),
      h(Box, {
        flexDirection: 'column', width: part.w, height: part.h - 1, borderStyle: ascii ? 'classic' : 'single', borderTop: false,
        ...(bcolor ? { borderColor: bcolor } : {}),
        ...(T.inkColor('panel', level, 'bg') ? { backgroundColor: T.inkColor('panel', level, 'bg') } : {}),
      }, ...rows(lines, 'panel')));
  }

  function helpBox(m, size) {
    const bw = Math.min(size.cols - 4, 52);
    const bh = m.help.length + 2;
    const bcolor = T.inkColor('violet', level, 'fg');
    return h(Box, {
      key: 'help', position: 'absolute', marginLeft: Math.floor((size.cols - bw) / 2), marginTop: Math.max(0, Math.floor((size.rows - bh) / 2)),
      width: bw, height: bh, flexDirection: 'column', borderStyle: ascii ? 'classic' : 'single',
      ...(bcolor ? { borderColor: bcolor } : {}),
      ...(T.inkColor('panel2', level, 'bg') ? { backgroundColor: T.inkColor('panel2', level, 'bg') } : {}),
    }, ...rows(m.help, 'panel2'));
  }

  return function WatchView({ model: m, ui, size }) {
    const bgInk = T.inkColor('ink', level, 'bg');
    const rootProps = { width: size.cols, height: size.rows, flexDirection: 'column', ...(bgInk ? { backgroundColor: bgInk } : {}) };
    if (m.layout === 'tooSmall') {
      return h(Box, { ...rootProps, justifyContent: 'center', alignItems: 'center' }, row(m.tooSmall, 'small', 'ink'));
    }
    const lay = m.lay;
    const panes = [pane(m, 'list', lay, ui.focus === 'devices'), pane(m, 'detail', lay, ui.focus === 'detail')];
    return h(Box, rootProps,
      row(m.header, 'header', 'panel2'),
      h(Box, { flexDirection: lay.kind === 'side' ? 'row' : 'column', height: lay.body, flexShrink: 0 }, ...panes),
      row(m.footer, 'footer', 'ink'),
      ...(m.help ? [helpBox(m, size)] : []));
  };
}

function createWatchApp({ ink, React, view, flags = {}, io = {}, level = 'none', ascii = false }) {
  const h = React.createElement;
  const { useInput, useApp, useWindowSize } = ink;
  const nowFn = io.now || Date.now;
  const snap = (all) => view.snapshot({ host: flags.host, all: !!all, historyN: flags.tail || 10 });
  const WatchView = createWatchView({ ink, React, level, ascii });

  return function WatchApp() {
    const { exit } = useApp();
    const win = useWindowSize();
    const size = { cols: win.columns || 80, rows: win.rows || 24 };
    const [board, setBoard] = React.useState(() => snap(flags.all));
    const [ui, setUi] = React.useState(() => W.initialUi(size, flags, board));
    const [now, setNow] = React.useState(() => nowFn());
    const ref = React.useRef({});
    ref.current = { board, ui, size };

    const refresh = React.useCallback((all) => {
      try { const b = snap(all); setBoard(b); setUi((u) => W.syncSelection(u, b)); }
      catch (e) { setBoard((b) => ({ ...b, error: T.sanitize(e && e.message, SNAP_ERR_MAX) })); }
    }, []);

    React.useEffect(() => { setUi((u) => W.resize(u, size, ref.current.board)); }, [size.cols, size.rows]);
    React.useEffect(() => {
      const t = setInterval(() => { if (!ref.current.ui.paused) refresh(ref.current.ui.all); }, flags.intervalMs || 2000);
      return () => clearInterval(t);
    }, []);
    React.useEffect(() => {
      const t = setInterval(() => { if (!ref.current.ui.paused) setNow(nowFn()); }, 1000);
      return () => clearInterval(t);
    }, []);

    useInput((input, key) => {
      const name = W.inkKeyName(input, key);
      if (!name) return;
      const { board: b, ui: u } = ref.current;
      const r = W.reduce(u, name, b, nowFn());
      if (r.ui !== u) setUi(r.ui);
      if (r.effects.includes('quit')) { exit(); return; }
      if (r.effects.includes('snapshot')) { setNow(nowFn()); refresh(r.ui.all); }
    });

    const model = W.renderModel(board, { ...ui, cols: size.cols, rows: size.rows }, size, now, { level, ascii });
    return h(WatchView, { model, ui, size });
  };
}

// Mount the screen on io.stdin/io.stdout and resolve with the exit code once it is gone.
// Terminal restore is ink's (alternate screen, cursor, raw mode); we only make sure every way out unmounts it.
async function mountWatchApp({ ink, React, view, flags = {}, io = {}, proc = process }) {
  const env = io.env || {};
  const level = T.detectColorLevel({ env, isTTY: true, getColorDepth: io.getColorDepth });
  const ascii = T.glyphSet(env) === T.GLYPHS.ascii;
  const App = createWatchApp({ ink, React, view, flags, io, level, ascii });
  const stderr = io.stderr || process.stderr;
  let instance;
  let code = null;
  const handlers = [];
  const on = (ev, fn) => { proc.on(ev, fn); handlers.push([ev, fn]); };
  const stop = (c) => { if (code == null) code = c; try { if (instance) instance.unmount(); } catch { /* already gone */ } };
  try {
    instance = ink.render(React.createElement(App), {
      stdin: io.stdin || process.stdin, stdout: io.stdout || process.stdout, stderr,
      alternateScreen: true, interactive: true, exitOnCtrlC: true, patchConsole: false, incrementalRendering: true,
    });
    on('SIGINT', () => stop(130));
    on('SIGTERM', () => stop(143));
    on('SIGHUP', () => stop(129));
    const fail = (e) => { stop(1); stderr.write(`[brighttest device watch] ${e && e.stack ? e.stack : e}\n`); };
    on('uncaughtException', fail);
    on('unhandledRejection', fail);
    await instance.waitUntilExit();
    return code == null ? 0 : code;
  } catch (e) {
    stop(1);
    stderr.write(`[brighttest device watch] ${e && e.message ? e.message : e}\n`);
    return 1;
  } finally {
    for (const [ev, fn] of handlers) proc.removeListener(ev, fn);
    try { view.close(); } catch { /* best effort */ }
  }
}

module.exports = { createWatchView, createWatchApp, mountWatchApp };
