'use strict';
// Turn a parsed sgnodes tree into absolute screen rects for the studio overlay, and work out which of
// those nodes the device is ACTUALLY drawing.
//
// POSITION comes from the translation chain: a node's `translation` is relative to its parent, exactly as
// SceneGraph composes it, so absolute origin = the sum of every ancestor's translation plus its own. Size
// comes from `bounds`. Measured against a Roku Ultra (fw 15.3.4) on two real apps, reading positions off a
// matched screenshot:
//
//     label                   screenshot   translation-sum   old bounds heuristic
//     "Latest Full Episodes"  {160, 38}    {160, 34}         {0, 0}
//     "Trending Shows"        {160, 428}   {160, 425}        {0, 0}
//     "Comedies"              {160, 865}   {160, 861}        {0, 0}
//
// This replaces an earlier heuristic that inferred absolute-vs-local from whether a child's `bounds` rect
// was contained in its parent's. That worked on the shallow sample app but collapses on real apps, which
// nest a dozen levels deep through nodes that report `bounds=null` (RowListItem) or a content-relative
// rect with a negative origin (`bounds={-22, 36.4, …}`). `bounds` x/y is a content offset, not a position,
// and is deliberately ignored here.
//
// KNOWN GAP: ArrayGrid/RowList lay their rows out internally and `RowListItem` exposes no bounds, no
// translation and no index, so a row's vertical offset within a RowList is not recoverable from sgnodes.
// Rows after the first therefore share the first row's y. Nothing in the ECP payload fixes this.
//
// VISIBILITY: having `bounds` does NOT mean a node is on screen. sgnodes/all dumps the WHOLE tree — hidden
// drawers, preloaded sibling screens, and every virtualized grid item. On a large production app 1597 of 2079 candidate
// overlays were fully transparent. So we also derive, per node:
//   • `shown`    — `visible` and `opacity` are INHERITED, so one hidden ancestor hides a whole subtree
//   • `clip`     — the screen viewport, narrowed by every ancestor that clips
//   • `vis`      — abs ∩ clip: the part the user can actually see (null once fully clipped away)
//   • `onScreen` — shown && vis, i.e. the device is drawing at least part of this node

const MIN_OPACITY = 0.01; // at or below this a node contributes nothing visible

// ArrayGrid and its subclasses render only the items inside their own rect — a row scrolled off to the
// right still reports bounds but is not drawn. Group clips only when clippingRect is set (handled below).
const CLIPS_TO_BOUNDS = new Set([
  'ArrayGrid', 'RowList', 'ZoomRowList', 'MarkupGrid', 'MarkupList',
  'LabelList', 'PosterGrid', 'TimeGrid', 'CheckList', 'RadioButtonList',
]);

// The design resolutions a Roku app can render at (manifest `ui_resolutions`). Node bounds are expressed
// in one of these coordinate spaces.
const UI_RESOLUTIONS = [{ w: 1920, h: 1080 }, { w: 1280, h: 720 }];
const DEFAULT_SCREEN = { w: 1920, h: 1080 };

// A node's effective type: real apps subclass the built-ins, so `<VideoRow extends="RowList">` must be
// recognised as a RowList. sgnodes exposes the base type in `extends`.
function typeNames(node) {
  const ext = node.attrs && node.attrs.extends;
  return ext ? [node.subtype, ext] : [node.subtype];
}

// Wire format for `opacity` is 0-100 (confirmed on a Roku Ultra, fw 15.3.4: values 0, 10, 45, 50, 80, 90,
// 100), even though the BrightScript field is 0.0-1.0. Values already in 0..1 are passed through so either
// scale works; `1` is read as fully opaque, which is the safe direction (showing beats wrongly hiding).
function normalizeOpacity(v) {
  if (typeof v !== 'number' || Number.isNaN(v)) return 1;
  if (v > 1) return Math.min(v / 100, 1);
  return Math.max(v, 0);
}

// Overlap of two rects, or null when they don't meet. Used for viewport + ancestor clipping.
function intersect(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (right <= x || bottom <= y) return null;
  return { x, y, w: right - x, h: bottom - y };
}

// The design resolution to scale FROM — the coordinate space node bounds live in, and the viewBox the
// client renders the overlay into.
//
// `screen` (from the device's ui-resolution) is the default when the caller has it, unless the tree shows the
// app lays out in the other design resolution (see below). Otherwise look for a
// node whose rect is exactly a known UI resolution at the origin; a full-screen background is present in
// every real app (a large production app has 20 such nodes).
//
// What this must NOT do is take the max extent over every node. That was the original approach and it is
// actively wrong: a Scene's `bounds` is the union of its descendants, so on a real app it reports things
// like {-1920, -652, 9600, 2048} (measured, and it changes as content scrolls). Max extent turned that
// into a 9600x1921 viewBox, squashing the whole overlay to a fifth of its correct width. Nor can the Scene
// node itself be trusted for this, for the same reason — and it is subclassed anyway (`Landing extends=
// "Scene"`), so it is not even findable by tag name.
function sceneSize(roots, { screen } = {}) {
  const seen = []; // known UI resolutions with a node exactly filling them at the origin, in walk order
  (function walk(nodes) {
    for (const n of nodes) {
      if (n.bounds && n.bounds.x === 0 && n.bounds.y === 0) {
        const r = UI_RESOLUTIONS.find((u) => u.w === n.bounds.w && u.h === n.bounds.h);
        if (r && !seen.includes(r)) seen.push(r);
      }
      if (n.children && n.children.length) walk(n.children);
    }
  })(roots || []);

  if (screen && screen.w > 0 && screen.h > 0) {
    // The device's ui-resolution is the display mode, not the app's: an app with manifest ui_resolutions=hd
    // on a 1080p output still lays out in 1280x720 (and an fhd app on a 720p output in 1920x1080). When the
    // tree shows a full-screen node only in the other design resolution, the tree is the app's real space.
    const same = seen.some((r) => r.w === screen.w && r.h === screen.h);
    if (!same && seen.length === 1) return { w: seen[0].w, h: seen[0].h };
    return { w: screen.w, h: screen.h };
  }
  return seen.length ? { w: seen[0].w, h: seen[0].h } : { ...DEFAULT_SCREEN };
}

// `clippingRect` is expressed in the node's own local space; {0,0,0,0} (or absent) means "no clipping".
// Returns the rect in absolute coordinates, or null when inactive.
function clippingRectOf(node, abs) {
  const raw = node.attrs && node.attrs.clippingRect;
  if (!raw || !abs) return null;
  const m = String(raw).match(/-?\d+(?:\.\d+)?/g);
  if (!m || m.length < 4) return null;
  const [x, y, w, h] = m.map(Number);
  if (!(w > 0) || !(h > 0)) return null;
  return { x: abs.x + x, y: abs.y + y, w, h };
}

// ---------------------------------------------------------------------------------------------------
// Grid item layout synthesis.
//
// An ArrayGrid-family container lays its items out internally: the item wrapper it creates exposes no
// translation, no bounds, no index — the offset is simply absent from the sgnodes payload. (Verified on
// device: the per-node ECP query exposes no layout fields either, grid bounds do not move on scroll, and
// neither app embeds RALE's TrackerTask.) But the payload leaks one strong signal:
//
//   ONLY THE ITEMS BEING DRAWN HAVE REALIZED GEOMETRY. A rendered item's wrapper contains tile-sized
//   bounds within a couple of levels (its Poster/GridTile); an off-screen item's wrapper contains none
//   (only recycled scraps at depth ~8). Measured on a large production app: exactly children 1..6 of a 16-child,
//   26-item carousel carried shallow geometry — precisely the six cards on screen, in on-screen order.
//
// That yields a run-anchored model: the rendered run spans the grid's drawn region, so the first rendered
// wrapper sits at slot 0 (the grid's origin), each subsequent one a stride later. Because the run itself
// encodes the scroll position, this holds for scrolled rows regardless of the grid's focus style — no
// focusItem math. Items outside the run get extrapolated slots, land outside the grid's clip, and are
// correctly reported off-screen (they are, by definition of the signal, not drawn).
//
// Stride comes in two tiers:
//   • estimated — median rendered-item size + a spacing estimate from the leftover span. Positions are
//     approximate (the true itemSpacing is unknowable; measured error ~4% of stride per slot).
//   • exact — layout hints published by the app itself into a hidden `__bt_layout` node (the __bt_state
//     pattern; see BTLayout_publish): itemSize/itemSpacing/numColumns straight from the grid's fields.
//     Keyed by node id; rows sharing a template share an id, which is exactly right.
// ---------------------------------------------------------------------------------------------------

const SHALLOW_GEOM_DEPTH = 3; // rendered tile content (Poster/GridTile) sits within a couple of levels
const MIN_ITEM_SPAN = 24;     // px — smaller shallow rects are decorations, not tile content

// The first tile-sized rect near the top of an item wrapper, or null when the item isn't rendered.
function shallowItemRect(wrapper) {
  let best = null;
  (function scan(x, d) {
    if (best) return;
    if (x.bounds && x.bounds.w >= MIN_ITEM_SPAN && x.bounds.h >= MIN_ITEM_SPAN) { best = x.bounds; return; }
    if (d < SHALLOW_GEOM_DEPTH) (x.children || []).forEach((c) => scan(c, d + 1));
  })(wrapper, 0);
  return best;
}

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

// List types that stack their items vertically by definition (RowList stacks rows; the *List widgets are
// vertical menus). Subclasses are caught via the `extends` attribute.
const VERTICAL_GRIDS = new Set(['RowList', 'ZoomRowList', 'MarkupList', 'LabelList', 'CheckList', 'RadioButtonList']);

// Per-child offsets for a grid's internally-laid-out item wrappers.
// Returns Map(childIndex -> { dx, dy, rendered }) or null when the grid has nothing to lay out.
function gridItemLayout(n, gridRect, hint) {
  // Item wrappers are the children the grid positions itself — no geometry of their own. Children that
  // do carry translation/bounds (and ContentNode data rows) are left to the normal walk.
  const wrappers = [];
  (n.children || []).forEach((c, i) => {
    if (c.subtype === 'ContentNode' || c.translation || c.bounds) return;
    wrappers.push({ i, rect: shallowItemRect(c) });
  });
  if (wrappers.length < 2 || !wrappers.some((w) => w.rect)) return null;

  // Repair holes inside the run: rendered items are contiguous by construction, but a FOCUSED item nests
  // its geometry under an extra focus-ring level that the shallow scan misses (measured: the focused nav
  // row). A gap between two rendered wrappers is therefore a rendered item too — without this the later
  // slots all shift by one and the focused item itself reads as off-screen. (The scan depth cannot simply
  // be raised instead: unrendered wrappers carry recycled scraps at depth ~8 that would read as geometry.)
  const first = wrappers.findIndex((w) => w.rect);
  const last = wrappers.length - 1 - [...wrappers].reverse().findIndex((w) => w.rect);
  const withRun = wrappers.map((w, ordinal) => ({ ...w, ordinal, rendered: ordinal >= first && ordinal <= last }));
  const rendered = withRun.filter((w) => w.rect); // sizing still uses only items with real geometry

  // Median of the RENDERED items' content size — median, because the focused tile reports its scaled-up
  // size (measured: 423x260 focused vs 326x184 rest) and edge tiles can report clipped rects. This can
  // UNDERSTATE the true item span when the shallow geometry is only part of the row (a nav item's 30px
  // icon, not the 74px row) — the run-span estimate below compensates.
  const itemW = (hint && hint.itemSize && hint.itemSize[0]) || median(rendered.map((w) => w.rect.w));
  const itemH = (hint && hint.itemSize && hint.itemSize[1]) || median(rendered.map((w) => w.rect.h));
  if (!(itemW > 0) || !(itemH > 0)) return null;

  // Orientation: RowList/*List types are vertical by definition; otherwise items as wide as the grid
  // stack vertically; a grid not tall enough for two rows is a horizontal carousel; the rest fill
  // row-major.
  const vertical = typeNames(n).some((t) => VERTICAL_GRIDS.has(t)) || itemW >= gridRect.w * 0.8;
  const singleRow = !vertical && gridRect.h < itemH * 1.9;
  const cols = vertical ? 1
    : (hint && hint.numColumns) || (singleRow ? Math.max(rendered.length, 1) : Math.max(1, Math.round(gridRect.w / itemW)));

  // Stride. Exact when hinted. Otherwise two independent estimates, take the larger:
  //   • item size + leftover-span gap — right when the shallow geometry is the full tile;
  //   • drawn span / run length — the grid's bounds cover exactly what it draws, so a fully-drawn run
  //     divides it evenly (measured: 296/4 = 74 vs a true 73.5 on a nav list whose icons understate the
  //     row). Underestimates ~4% when the run's last item is partially clipped.
  // Both underestimate, never overestimate, so max() is the better of the two.
  const estGapX = cols > 1 ? Math.max(0, (gridRect.w - cols * itemW) / cols) : 0;
  const visRows = Math.max(1, Math.round(gridRect.h / itemH));
  const estGapY = Math.max(0, (gridRect.h - visRows * itemH) / visRows);
  const hintSX = hint && hint.itemSpacing && hint.itemSpacing[0];
  const hintSY = hint && hint.itemSpacing && hint.itemSpacing[1];
  const runLen = last - first + 1;
  let strideX = itemW + (hintSX ?? estGapX);
  let strideY = itemH + (hintSY ?? estGapY);
  if (!hint) {
    if (singleRow) strideX = Math.max(strideX, gridRect.w / runLen);
    if (vertical) strideY = Math.max(strideY, gridRect.h / runLen);
  }

  // Slot 0 sits at the grid's origin — deliberately NOT offset by bounds x/y. That offset is usually
  // decoration slop (±22px of focus glow), and when it IS real layout (a centered list drawing above its
  // origin) the app's own translation already encodes it, so applying bounds too counts it twice
  // (measured: navButtons has translation {0,-148} AND bounds y=-148; the double shift pushed every item
  // outside the grid's own clip).
  const out = new Map();
  withRun.forEach((w) => {
    const slot = w.ordinal - first;
    // Slots before the run (scrolled-off items) extend backwards along the primary axis — they must
    // never wrap onto a phantom "row -1", which would land them INSIDE the viewport at a fabricated
    // position. Slots at/after the run start fold row-major only in true multi-row grids.
    const wraps = !singleRow && !vertical && slot >= 0;
    const row = wraps ? Math.floor(slot / cols) : 0;
    const col = vertical ? 0 : (wraps ? slot - row * cols : slot);
    out.set(w.i, {
      dx: vertical ? 0 : col * strideX,
      dy: vertical ? slot * strideY : row * strideY,
      rendered: w.rendered,
    });
  });
  return out;
}

// Walk the tree, attaching an absolute rect (`abs`), inherited visibility, and the visible sub-rect
// (`vis`) to every node that has bounds. Returns a flat list of lightweight projections (no circular
// refs) ready to serialize to the browser.
//
// `viewport` bounds what counts as on-screen and defaults to the scene rect. Pass `null` to disable
// viewport clipping (ancestor clipping still applies). `layout` holds app-published grid layout hints
// (see gridItemLayout), keyed by node id or subtype.
function resolveAbsolute(roots, { viewport, screen, layout } = {}) {
  const list = roots || [];
  const clipRoot = viewport === undefined
    ? (() => { const s = sceneSize(list, { screen }); return { x: 0, y: 0, w: s.w, h: s.h }; })()
    : viewport;

  const hints = layout || null;
  const out = [];
  const walk = (n, parentOrigin, depth, path, inherited) => {
    // Absolute origin = the accumulated translation chain, the way SceneGraph composes it, plus any
    // synthesized grid-item offset from the parent (see gridItemLayout). `bounds` only supplies size;
    // its x/y is a content offset relative to this origin, not a position.
    const t = n.translation;
    const lo = inherited.itemLayout ? inherited.itemLayout.offset : null;
    const origin = {
      x: parentOrigin.x + (t ? t.x : 0) + (lo ? lo.dx : 0),
      y: parentOrigin.y + (t ? t.y : 0) + (lo ? lo.dy : 0),
    };
    const abs = n.bounds ? { x: origin.x, y: origin.y, w: n.bounds.w, h: n.bounds.h } : null;

    // Position provenance, inherited: 'translation' (real chain) > 'hint' (app-published grid layout) >
    // 'run' (rendered-run estimate) > 'origin' (a grid item wrapper we could not lay out at all).
    let posSource = inherited.posSource;
    if (lo) posSource = inherited.itemLayout.source;
    else if (inherited.parentIsGrid && !n.translation && !n.bounds) posSource = 'origin';
    const posExact = posSource === 'translation' || posSource === 'hint';

    // visible/opacity are inherited: one hidden ancestor hides the subtree, and opacity multiplies down
    // the chain, so a 0-opacity container hides every descendant however opaque each one claims to be.
    // An item wrapper the grid is NOT drawing (no realized geometry) hides its subtree the same way.
    const effOpacity = inherited.opacity * normalizeOpacity(n.opacity);
    const shown = inherited.shown && n.visible !== false && effOpacity > MIN_OPACITY &&
      !(lo && !inherited.itemLayout.rendered);

    const clip = inherited.clip;
    const vis = abs ? intersect(abs, clip) : null;

    out.push({
      path, depth,
      subtype: n.subtype, id: n.id, text: n.text,
      focusable: n.focusable, focused: n.focused, visible: n.visible,
      opacity: n.opacity === undefined ? null : n.opacity,
      childCount: n.children ? n.children.length : 0,
      attrs: n.attrs || {},
      raw: n.bounds || null,
      abs,
      // Derived rendering facts the overlay filters on.
      shown,
      effOpacity,
      clip: clip ? { ...clip } : null,
      vis,
      onScreen: Boolean(shown && vis),
      posExact,
      posSource,
    });

    // Clip region for this node's children: the ancestors' clip, narrowed by whatever this node clips with.
    const isGrid = typeNames(n).some((tn) => CLIPS_TO_BOUNDS.has(tn));
    let childClip = clip;
    if (abs) {
      if (isGrid) childClip = intersect(childClip, abs);
      const cr = clippingRectOf(n, abs);
      if (cr) childClip = intersect(childClip, cr);
    }

    // Lay out this grid's item wrappers (run-anchored; exact when the app published a hint for it).
    let itemOffsets = null, itemSource = 'run';
    if (isGrid && abs) {
      const hint = hints ? (hints[n.id] || hints[n.subtype] || null) : null;
      itemOffsets = gridItemLayout(n, abs, hint);
      if (hint && itemOffsets) itemSource = 'hint';
    }

    const childBase = { shown, opacity: effOpacity, clip: childClip, posSource, parentIsGrid: isGrid };
    (n.children || []).forEach((c, i) => {
      const off = itemOffsets ? itemOffsets.get(i) : undefined;
      const childInherited = off
        ? { ...childBase, itemLayout: { offset: off, rendered: off.rendered, source: itemSource } }
        : { ...childBase, itemLayout: null };
      walk(c, origin, depth + 1, `${path}/${i}`, childInherited);
    });
  };

  list.forEach((r, i) => walk(r, { x: 0, y: 0 }, 0, String(i),
    { shown: true, opacity: 1, clip: clipRoot, posSource: 'translation', parentIsGrid: false, itemLayout: null }));
  return out;
}

// Both projections, computed consistently against one viewport. Prefer this over calling sceneSize and
// resolveAbsolute separately — it guarantees the clip region matches the viewBox the client renders into.
// Pass `screen` (from the device's ui-resolution) whenever it's known; it beats every tree heuristic.
// Pass `layout` (from appstate.extractLayoutHints) to make grid item positions exact where the app
// publishes its grids' layout fields.
function project(roots, { screen, layout } = {}) {
  const scene = sceneSize(roots, { screen });
  return { scene, nodes: resolveAbsolute(roots, { viewport: { x: 0, y: 0, w: scene.w, h: scene.h }, layout }) };
}

// "1080p" / "720p" (ECP device-info ui-resolution) → the design resolution. Null when unrecognised, so
// callers fall back to the tree heuristic rather than trusting a guess.
function screenFromUiResolution(ui) {
  const s = String(ui || '').toLowerCase();
  if (s.includes('1080')) return { w: 1920, h: 1080 };
  if (s.includes('720')) return { w: 1280, h: 720 };
  return null;
}

module.exports = {
  intersect, sceneSize, resolveAbsolute, project, clippingRectOf, gridItemLayout, shallowItemRect,
  normalizeOpacity, typeNames, screenFromUiResolution, UI_RESOLUTIONS,
};
