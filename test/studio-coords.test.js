import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const coords = require('../lib/studio/coords.js');

// Minimal node factory matching what lib/e2e/sgnodes.js `toNode` produces. `t` is translation (the thing
// that positions a node); `b` is bounds (which only supplies size).
const node = (subtype, b, extra = {}) => ({
  subtype,
  id: extra.id ?? null,
  text: extra.text ?? null,
  bounds: b ? { x: b[0], y: b[1], w: b[2], h: b[3] } : null,
  translation: extra.t ? { x: extra.t[0], y: extra.t[1] } : null,
  visible: extra.visible ?? null,
  focusable: extra.focusable ?? null,
  focused: extra.focused ?? false,
  opacity: extra.opacity ?? null,
  attrs: extra.attrs ?? {},
  children: extra.children ?? [],
});

const scene = (children) => [node('Scene', [0, 0, 1920, 1080], { children })];
const at = (nodes, path) => nodes.find((n) => n.path === path);
const proj = (roots, layout) => coords.project(roots, { screen: { w: 1920, h: 1080 }, layout }).nodes;

describe('sceneSize', () => {
  it('trusts an explicit screen size above anything in the tree', () => {
    const roots = [node('Landing', [-1920, -652, 9600, 2048], { attrs: { extends: 'Scene' } })];
    expect(coords.sceneSize(roots, { screen: { w: 1280, h: 720 } })).toEqual({ w: 1280, h: 720 });
  });

  it('never uses max extent — a Scene\'s bounds is the union of its descendants', () => {
    // Measured on a real app: the Scene reports {-1920,-652,9600,2048}. Max extent turned that into a
    // 9600x1921 viewBox and squashed the overlay to a fifth of its width.
    const roots = [node('Landing', [-1920, -652, 9600, 2048], {
      attrs: { extends: 'Scene' },
      children: [node('Rectangle', [0, 0, 1920, 1080])],
    })];
    expect(coords.sceneSize(roots)).toEqual({ w: 1920, h: 1080 });
  });

  it('finds a full-screen background node at a known UI resolution', () => {
    expect(coords.sceneSize([node('Group', null, { children: [node('Rectangle', [0, 0, 1280, 720])] })]))
      .toEqual({ w: 1280, h: 720 });
  });

  it('defaults to 1920x1080 when there is no full-screen node', () => {
    expect(coords.sceneSize([node('Group', [0, 0, 640, 480])])).toEqual({ w: 1920, h: 1080 });
    expect(coords.sceneSize([])).toEqual({ w: 1920, h: 1080 });
  });
});

describe('screenFromUiResolution', () => {
  it('maps the ECP ui-resolution string', () => {
    expect(coords.screenFromUiResolution('1080p')).toEqual({ w: 1920, h: 1080 });
    expect(coords.screenFromUiResolution('720p')).toEqual({ w: 1280, h: 720 });
  });

  it('returns null when unrecognised so callers fall back rather than guess', () => {
    expect(coords.screenFromUiResolution('')).toBeNull();
    expect(coords.screenFromUiResolution(null)).toBeNull();
    expect(coords.screenFromUiResolution('4k')).toBeNull();
  });
});

describe('resolveAbsolute — position from the translation chain', () => {
  it('accumulates translations down the tree', () => {
    const roots = scene([node('Group', null, { t: [100, 50], children: [
      node('Group', null, { t: [60, 45], children: [node('Label', [0, 0, 303, 38], { id: 'deep' })] }),
    ] })]);
    // 100+60 = 160, 50+45 = 95 — the shape measured on device for a row header.
    expect(at(proj(roots), '0/0/0/0').abs).toEqual({ x: 160, y: 95, w: 303, h: 38 });
  });

  it('ignores bounds x/y — it is a content offset, not a position', () => {
    // Measured: nodes report things like bounds={-22, 36.4, 1964, 472.8} while translation carries the
    // real offset. Using bounds x/y as a position is what broke the old heuristic.
    const roots = scene([node('MarkupGrid', [-22, 36.4, 1964, 472.8], { t: [160, 57], id: 'grid' })]);
    expect(at(proj(roots), '0/0').abs).toEqual({ x: 160, y: 57, w: 1964, h: 472.8 });
  });

  it('gives a node with no translation its parent origin', () => {
    const roots = scene([node('Group', null, { t: [170, 292], children: [
      node('Label', [0, 36, 306, 36], { id: 'notrans' }),
    ] })]);
    expect(at(proj(roots), '0/0/0').abs).toEqual({ x: 170, y: 292, w: 306, h: 36 });
  });

  it('leaves abs null for a node with no bounds, but still passes its origin down', () => {
    const roots = scene([node('RenderableNode', null, { t: [10, 20], children: [
      node('Label', [0, 0, 50, 10], { id: 'child' }),
    ] })]);
    const nodes = proj(roots);
    expect(at(nodes, '0/0').abs).toBeNull();
    expect(at(nodes, '0/0/0').abs).toEqual({ x: 10, y: 20, w: 50, h: 10 });
  });
});

describe('resolveAbsolute — inherited visibility', () => {
  it('hides descendants of a visible=false ancestor even when they claim visible=true', () => {
    const roots = scene([node('Group', [0, 0, 400, 400], { id: 'drawer', visible: false,
      children: [node('Label', [0, 0, 100, 20], { id: 'buried', visible: true })] })]);
    const nodes = proj(roots);
    expect(at(nodes, '0/0').onScreen).toBe(false);
    expect(at(nodes, '0/0/0').visible).toBe(true);   // own flag untouched
    expect(at(nodes, '0/0/0').onScreen).toBe(false); // but not drawn
  });

  it('hides a subtree under a zero-opacity ancestor however opaque the child claims to be', () => {
    const roots = scene([node('Group', [0, 0, 400, 400], { opacity: 0,
      children: [node('Label', [0, 0, 100, 20], { id: 'ghost', opacity: 100 })] })]);
    expect(at(proj(roots), '0/0/0').onScreen).toBe(false);
  });

  it('multiplies opacity down the chain', () => {
    const roots = scene([node('Group', [0, 0, 400, 400], { opacity: 50,
      children: [node('Label', [0, 0, 100, 20], { id: 'faded', opacity: 50 })] })]);
    const child = at(proj(roots), '0/0/0');
    expect(child.effOpacity).toBeCloseTo(0.25); // 0.5 * 0.5
    expect(child.onScreen).toBe(true);
  });

  it('treats absent visible/opacity as visible and opaque', () => {
    const n = at(proj(scene([node('Label', [0, 0, 100, 20], { id: 'plain' })])), '0/0');
    expect(n.onScreen).toBe(true);
    expect(n.effOpacity).toBe(1);
  });
});

describe('normalizeOpacity', () => {
  it('reads the 0-100 wire scale', () => {
    // Measured on device: opacity arrives as 0, 10, 45, 50, 80, 90, 100.
    expect(coords.normalizeOpacity(100)).toBe(1);
    expect(coords.normalizeOpacity(90)).toBeCloseTo(0.9);
    expect(coords.normalizeOpacity(0)).toBe(0);
  });

  it('passes through a 0..1 scale, reading 1 as fully opaque', () => {
    expect(coords.normalizeOpacity(1)).toBe(1);
    expect(coords.normalizeOpacity(0.5)).toBe(0.5);
  });

  it('defaults to opaque for absent or bad values', () => {
    expect(coords.normalizeOpacity(null)).toBe(1);
    expect(coords.normalizeOpacity(undefined)).toBe(1);
    expect(coords.normalizeOpacity(NaN)).toBe(1);
  });
});

describe('resolveAbsolute — viewport clipping', () => {
  it('drops a node positioned entirely off screen', () => {
    const roots = scene([node('Group', [0, 0, 300, 100], { t: [2200, 100], id: 'offright' })]);
    const n = at(proj(roots), '0/0');
    expect(n.vis).toBeNull();
    expect(n.onScreen).toBe(false);
    expect(n.abs).toEqual({ x: 2200, y: 100, w: 300, h: 100 }); // still reported for the offscreen toggle
  });

  it('clips a partially off-screen node to its visible part', () => {
    const roots = scene([node('Group', [0, 0, 200, 100], { t: [1820, 0], id: 'straddle' })]);
    expect(at(proj(roots), '0/0').vis).toEqual({ x: 1820, y: 0, w: 100, h: 100 });
  });

  it('honours an explicit viewport, and disables viewport clipping when passed null', () => {
    const roots = scene([node('Group', [0, 0, 300, 100], { t: [2200, 100], id: 'off' })]);
    expect(coords.resolveAbsolute(roots, { viewport: { x: 0, y: 0, w: 4000, h: 1080 } })
      .find((n) => n.path === '0/0').onScreen).toBe(true);
    expect(coords.resolveAbsolute(roots, { viewport: null })
      .find((n) => n.path === '0/0').onScreen).toBe(true);
  });
});

describe('resolveAbsolute — ancestor clipping', () => {
  it('clips grid items translated outside the grid rect', () => {
    const roots = scene([node('RowList', [0, 0, 1920, 200], { t: [0, 500], id: 'rows', children: [
      node('Poster', [0, 0, 300, 200], { t: [0, 0], id: 'item0' }),
      node('Poster', [0, 0, 300, 200], { t: [1700, 0], id: 'item1' }),   // straddles the right edge
      node('Poster', [0, 0, 300, 200], { t: [4000, 0], id: 'item9' }),   // scrolled out of view
    ] })]);
    const nodes = proj(roots);
    expect(at(nodes, '0/0/0').onScreen).toBe(true);
    expect(at(nodes, '0/0/1').vis).toEqual({ x: 1700, y: 500, w: 220, h: 200 });
    expect(at(nodes, '0/0/2').onScreen).toBe(false);
  });

  it('recognises a subclassed grid via the extends attribute', () => {
    // Real apps subclass: <DynamicMarkupGrid extends="MarkupGrid">.
    const roots = scene([node('DynamicMarkupGrid', [0, 0, 400, 200], {
      t: [0, 0], attrs: { extends: 'MarkupGrid' },
      children: [node('Poster', [0, 0, 100, 100], { t: [900, 0], id: 'out' })],
    })]);
    expect(at(proj(roots), '0/0/0').onScreen).toBe(false);
  });

  it('honours a Group clippingRect, which is local to the node', () => {
    const roots = scene([node('Group', [0, 0, 400, 400], {
      t: [200, 200], attrs: { clippingRect: '{0, 0, 100, 100}' },
      children: [
        node('Label', [0, 0, 40, 20], { t: [20, 20], id: 'inside' }),
        node('Label', [0, 0, 40, 20], { t: [200, 200], id: 'clipped' }),
      ],
    })]);
    const nodes = proj(roots);
    expect(at(nodes, '0/0/0').onScreen).toBe(true);
    expect(at(nodes, '0/0/1').onScreen).toBe(false);
  });

  it('ignores a zero-sized clippingRect ({0,0,0,0} means no clipping)', () => {
    const roots = scene([node('Group', [0, 0, 800, 600], {
      attrs: { clippingRect: '{0, 0, 0, 0}' },
      children: [node('Label', [0, 0, 40, 20], { t: [700, 500], id: 'ok' })],
    })]);
    expect(at(proj(roots), '0/0/0').onScreen).toBe(true);
  });

  it('does not clip a plain Group with no clippingRect', () => {
    const roots = scene([node('Group', [0, 0, 100, 100], {
      children: [node('Label', [0, 0, 800, 40], { id: 'overflows' })],
    })]);
    expect(at(proj(roots), '0/0/0').onScreen).toBe(true);
  });
});

describe('resolveAbsolute — posExact', () => {
  it('flags a grid item wrapper with no geometry, and everything under it', () => {
    // Measured shape: MarkupGrid → tile wrapper with neither translation nor bounds → real content.
    // The tile's offset is absent from sgnodes, so nothing below it has a resolvable origin.
    const roots = scene([node('MarkupGrid', [0, 0, 1920, 300], { t: [160, 57], id: 'grid', children: [
      node('GridTile', null, { children: [node('Label', [0, 0, 300, 36], { id: 'title' })] }),
    ] })]);
    const nodes = proj(roots);
    expect(at(nodes, '0/0').posExact).toBe(true);      // the grid itself is positioned
    expect(at(nodes, '0/0/0').posExact).toBe(false);   // the wrapper is not
    expect(at(nodes, '0/0/0/0').posExact).toBe(false); // and neither is its content
  });

  it('keeps posExact when the grid child does carry geometry', () => {
    const roots = scene([node('RowList', [0, 0, 1920, 300], { t: [0, 0], id: 'rows', children: [
      node('Item', [0, 0, 300, 200], { t: [420, 0], id: 'item1' }),
    ] })]);
    expect(at(proj(roots), '0/0/0').posExact).toBe(true);
  });

  it('is true throughout an ordinary translation-positioned tree', () => {
    const roots = scene([node('Group', null, { t: [10, 10], children: [
      node('Label', [0, 0, 50, 10], { id: 'a' }),
    ] })]);
    expect(proj(roots).every((n) => n.posExact)).toBe(true);
  });
});

describe('intersect', () => {
  it('returns the overlap', () => {
    expect(coords.intersect({ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 50, w: 100, h: 100 }))
      .toEqual({ x: 50, y: 50, w: 50, h: 50 });
  });

  it('returns null for disjoint and edge-touching rects', () => {
    expect(coords.intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 50, y: 50, w: 10, h: 10 })).toBeNull();
    expect(coords.intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBeNull();
  });

  it('passes through when one side is missing', () => {
    expect(coords.intersect(null, { x: 1, y: 2, w: 3, h: 4 })).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(coords.intersect({ x: 1, y: 2, w: 3, h: 4 }, null)).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });
});

describe('typeNames', () => {
  it('includes the extends base type', () => {
    expect(coords.typeNames({ subtype: 'DynamicMarkupGrid', attrs: { extends: 'MarkupGrid' } }))
      .toEqual(['DynamicMarkupGrid', 'MarkupGrid']);
    expect(coords.typeNames({ subtype: 'Label', attrs: {} })).toEqual(['Label']);
  });
});

describe('project', () => {
  it('clips against the same scene rect it reports', () => {
    const roots = scene([node('Poster', [0, 0, 300, 200], { t: [5000, 500], id: 'far' })]);
    const { scene: s, nodes } = coords.project(roots, { screen: { w: 1920, h: 1080 } });
    expect(s).toEqual({ w: 1920, h: 1080 });
    expect(at(nodes, '0/0').onScreen).toBe(false);
  });

  it('does not blow up on an empty tree', () => {
    expect(coords.project([])).toEqual({ scene: { w: 1920, h: 1080 }, nodes: [] });
  });
});

// ---------------------------------------------------------------------------------------------------
// Grid item layout synthesis (the run-anchored model). The fixture numbers replicate what was measured
// on a large production app (Roku Ultra, fw 15.3.4): a 16-child, 26-item carousel where exactly the on-screen items
// carry shallow tile geometry, in on-screen order.
// ---------------------------------------------------------------------------------------------------

const tile = (rendered, w = 326.4, h = 184) =>
  node('DynamicMarkupGridTile', null, {
    children: rendered
      ? [node('GridTile', [0, 0, w, h])]
      // unrendered items still carry recycled scraps DEEPER than the shallow scan looks (measured: d8)
      : [node('Group', null, { children: [node('Group', null, { children: [node('Group', null, {
          children: [node('Label', [0, 1, 35, 36], { id: 'probe' })] })] })] })],
  });

const carousel = (tiles, extra = {}) =>
  scene([node('DynamicMarkupGrid', [-22, -2.8, 1964, 472.8], {
    t: [160, 57], id: 'list', attrs: { extends: 'MarkupGrid', ...extra.attrs }, children: tiles,
  })]);

describe('gridItemLayout — run-anchored estimation', () => {
  it('positions the rendered run from the grid origin and marks the rest off-screen', () => {
    const tiles = [tile(true), tile(true), tile(true), tile(true), tile(true), tile(true),
      tile(false), tile(false), tile(false)];
    const nodes = proj(carousel(tiles));
    const rects = tiles.map((_, i) => at(nodes, `0/0/${i}/0`));
    expect(rects[0].abs.x).toBeCloseTo(160, 0);           // slot 0 at the grid origin
    expect(rects[1].abs.x).toBeGreaterThan(480);          // one stride later (~327+)
    expect(rects[0].posSource).toBe('run');
    expect(rects[0].posExact).toBe(false);
    expect(rects[0].onScreen).toBe(true);
    expect(rects[6].onScreen).toBe(false);                // not rendered by the device
    expect(rects[6].shown).toBe(false);
  });

  it('anchors to the run, not item 0, so a scrolled row stays correct', () => {
    // Items 0..1 scrolled off (no geometry), 2..7 rendered: slot 0 = item 2 at the grid origin.
    const tiles = [tile(false), tile(false), tile(true), tile(true), tile(true), tile(true), tile(true), tile(true)];
    const nodes = proj(carousel(tiles));
    expect(at(nodes, '0/0/2/0').abs.x).toBeCloseTo(160, 0);
    const probe = at(nodes, '0/0/0/0/0/0/0');             // deep label inside the scrolled-off item
    expect(probe.onScreen).toBe(false);                   // scrolled-off item sits left of the run
    expect(probe.abs.x).toBeLessThan(160);
  });

  it('repairs a hole inside the run (the focused item nests its geometry too deep to detect)', () => {
    const tiles = [tile(true), tile(false), tile(true), tile(true), tile(false), tile(false)];
    const nodes = proj(carousel(tiles));
    const focused = at(nodes, '0/0/1');                   // the hole
    expect(focused.shown).not.toBe(false);                // treated as rendered
    // and the slots after the hole are NOT shifted: tile 2 sits two strides in, not one
    const x0 = at(nodes, '0/0/0/0').abs.x;
    const x2 = at(nodes, '0/0/2/0').abs.x;
    expect((x2 - x0) / 2).toBeGreaterThan(300);           // two strides, not one
  });

  it('becomes exact with a __bt_layout hint', () => {
    const tiles = [tile(true), tile(true), tile(true), tile(true), tile(true), tile(true), tile(false)];
    const nodes = proj(carousel(tiles), { list: { itemSize: [326.4, 265], itemSpacing: [13.6, 0] } });
    // stride = 326.4 + 13.6 = 340 exactly (the value measured off the screenshot)
    expect(at(nodes, '0/0/2/0').abs.x).toBeCloseTo(160 + 2 * 340, 1);
    expect(at(nodes, '0/0/2/0').posSource).toBe('hint');
    expect(at(nodes, '0/0/2/0').posExact).toBe(true);
  });

  it('hints match by subtype as well as id', () => {
    const tiles = [tile(true), tile(true), tile(true)];
    const nodes = proj(carousel(tiles), { DynamicMarkupGrid: { itemSize: [326.4, 265], itemSpacing: [13.6, 0] } });
    expect(at(nodes, '0/0/1/0').posSource).toBe('hint');
  });

  it('lays a *List type out vertically with the span/run stride', () => {
    // A nav list whose shallow geometry (icons) understates the row height: 4 rendered rows over a
    // 296-high drawn span -> stride 74 (measured truth: 73.5).
    const rows = [0, 1, 2, 3].map(() =>
      node('SideNavButton', null, { children: [node('Rectangle', [0, 0, 154, 38])] }));
    const roots = scene([node('MarkupListEx', [0, -148, 250, 296], {
      t: [90, 583], id: 'nav', attrs: { extends: 'MarkupList' }, children: rows,
    })]);
    const nodes = proj(roots);
    const ys = [0, 1, 2, 3].map((i) => at(nodes, `0/0/${i}/0`).abs.y);
    expect(ys[1] - ys[0]).toBeCloseTo(74, 0);
    expect(ys[0]).toBeCloseTo(583, 0);                    // slot 0 at the grid origin, no double anchor
  });

  it('leaves grids with fewer than two wrappers alone', () => {
    const tiles = [tile(true)];
    const nodes = proj(carousel(tiles));
    expect(at(nodes, '0/0/0').posSource).toBe('origin');  // unresolvable, flagged, not guessed
  });

  it('skips ContentNode data children when assigning slots', () => {
    const tiles = [node('ContentNode', null), tile(true), tile(true)];
    const nodes = proj(carousel(tiles));
    expect(at(nodes, '0/0/1/0').abs.x).toBeCloseTo(160, 0); // first wrapper is child 1, slot 0
  });
});
