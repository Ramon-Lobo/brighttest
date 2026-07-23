'use strict';
// Resolve sgnodes `bounds` into absolute screen coordinates for the studio overlay, and scale them onto
// the screenshot's pixel space.
//
// Roku reports `bounds` inconsistently (confirmed on a Roku Ultra, FHD, against the sample app):
//   • Container/group nodes (Scene, RenderableNode, custom panels) report SCENE-ABSOLUTE bounds and do
//     NOT establish a local origin for their children.
//   • Widget nodes (Button, …) report their children in the widget's LOCAL coordinate space.
// The invariant that reconstructs true absolute positions for every node: a child's raw rect that is
// CONTAINED within its parent's raw rect is already absolute; one that is NOT contained is parent-local,
// so we offset it by the parent's absolute origin. Verified to reproduce every on-screen position on the
// sample app's Home screen. It's a heuristic (a widget sitting at the scene origin could fool it), so the
// overlay is always visually validated on-device and the client can fall back to raw bounds.

const TOL = 2; // px slack for the containment test

function rectContains(outer, inner) {
  return (
    inner.x >= outer.x - TOL &&
    inner.y >= outer.y - TOL &&
    inner.x + inner.w <= outer.x + outer.w + TOL &&
    inner.y + inner.h <= outer.y + outer.h + TOL
  );
}

// The design resolution to scale FROM: the largest node rect (the Scene fills the screen). Falls back to
// 1920×1080 if nothing has bounds.
function sceneSize(roots) {
  let w = 0, h = 0;
  (function walk(nodes) {
    for (const n of nodes) {
      if (n.bounds) { w = Math.max(w, n.bounds.x + n.bounds.w); h = Math.max(h, n.bounds.y + n.bounds.h); }
      if (n.children && n.children.length) walk(n.children);
    }
  })(roots);
  return { w: w || 1920, h: h || 1080 };
}

// Walk the tree, attaching an absolute rect (`abs`) to every node that has bounds. Returns a flat list of
// lightweight projections (no circular refs) ready to serialize to the browser.
function resolveAbsolute(roots) {
  const out = [];
  const walk = (n, parentRaw, parentAbs, depth, path) => {
    let abs = null;
    if (n.bounds) {
      // Contained (or root) → the raw rect is already scene-absolute; otherwise it's parent-local.
      if (!parentRaw || rectContains(parentRaw, n.bounds)) {
        abs = { x: n.bounds.x, y: n.bounds.y, w: n.bounds.w, h: n.bounds.h };
      } else {
        abs = { x: parentAbs.x + n.bounds.x, y: parentAbs.y + n.bounds.y, w: n.bounds.w, h: n.bounds.h };
      }
    }
    out.push({
      path, depth,
      subtype: n.subtype, id: n.id, text: n.text,
      focusable: n.focusable, focused: n.focused, visible: n.visible,
      childCount: n.children ? n.children.length : 0,
      attrs: n.attrs || {},
      raw: n.bounds || null,
      abs,
    });
    (n.children || []).forEach((c, i) => walk(c, n.bounds || parentRaw, abs || parentAbs, depth + 1, `${path}/${i}`));
  };
  roots.forEach((r, i) => walk(r, null, { x: 0, y: 0 }, 0, String(i)));
  return out;
}

module.exports = { rectContains, sceneSize, resolveAbsolute };
