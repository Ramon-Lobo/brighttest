'use strict';
const sg = require('./sgnodes');
const sel = require('./select');

// Focus navigator — the "click X" of a D-pad world. Roku has no tap: to act on a node you move focus to
// it with arrow presses, then Select. This is a bounded, deterministic closed loop:
//   read focus + target geometry → press toward the target → settle → re-read → repeat,
// backing off to the orthogonal axis at an edge and giving up (with a clear error) after maxPresses.
//
// It reasons over the parsed sgnodes tree (bounds/translation/focused), so it works on any app whose
// focus is observable there — no app cooperation beyond having focusable nodes.

const TOL = 4; // px: centers within this on an axis are treated as aligned (don't press that axis)

const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// The focused node we should steer FROM: the deepest focused node that has geometry. Scenes report the
// Scene itself as focused too (full-screen bounds); the deepest focused-with-bounds is the real cursor.
function focusedNode(roots) {
  const focused = sg.flatten(roots).filter((n) => n.focused && n.bounds);
  return focused.length ? focused[focused.length - 1] : null;
}

// True (returns the matched node) if a node matching `selector` — or any descendant of it — holds focus.
function targetFocused(roots, selector) {
  for (const m of sel.matchAll(roots, selector)) {
    if (subtreeFocused(m)) return m;
  }
  return null;
}
function subtreeFocused(node) {
  return node.focused || node.children.some(subtreeFocused);
}

// Same focus cursor between two reads? Compare by id when present, else by subtype + position.
function sameNode(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id) return a.id === b.id;
  const ca = center(a.bounds), cb = center(b.bounds);
  return a.subtype === b.subtype && Math.abs(ca.x - cb.x) < 1 && Math.abs(ca.y - cb.y) < 1;
}

function fail(msg, extra = {}) {
  const e = new Error(msg);
  e.code = 'FOCUS_FAILED';
  Object.assign(e, extra);
  return e;
}

// Drive focus onto the first node matching `selector`. Returns { presses }. Throws FOCUS_FAILED with a
// diagnostic message (current focus, presses used) when it can't get there.
async function focusTo(device, selector, { maxPresses = 30, settle } = {}) {
  const describe = sel.describe(selector);
  let tree = await sg.waitForSettle(device, settle);
  if (targetFocused(tree.roots, selector)) return { presses: 0 };

  let target = sel.matchOne(tree.roots, selector);
  if (!target) throw fail(`focus: ${describe} not found on screen`, { selector });
  if (!target.bounds) throw fail(`focus: ${describe} has no bounds — can't navigate to it`, { selector });

  const exhausted = { h: false, v: false };
  let presses = 0;
  let lastDist = Infinity;
  let stuck = 0;

  while (presses < maxPresses) {
    const cur = focusedNode(tree.roots);
    if (!cur) {
      // Nothing focused: nudge once to establish a cursor, then reassess.
      await device.keypress('Down'); presses++;
      tree = await sg.waitForSettle(device, settle);
      if (targetFocused(tree.roots, selector)) return { presses };
      if (!focusedNode(tree.roots)) throw fail('focus: nothing is focusable on screen', { selector });
      continue;
    }
    // Re-resolve the target each iteration — a scrolling list can move it under the cursor.
    target = sel.matchOne(tree.roots, selector) || target;
    const c = center(cur.bounds), t = center(target.bounds);
    const dx = t.x - c.x, dy = t.y - c.y;

    // Choose an axis to press: prefer the larger delta, skip aligned/exhausted axes.
    let axis, key;
    const wantH = Math.abs(dx) > TOL, wantV = Math.abs(dy) > TOL;
    const preferH = Math.abs(dx) >= Math.abs(dy);
    if (preferH && wantH && !exhausted.h) { axis = 'h'; key = dx > 0 ? 'Right' : 'Left'; }
    else if (wantV && !exhausted.v) { axis = 'v'; key = dy > 0 ? 'Down' : 'Up'; }
    else if (wantH && !exhausted.h) { axis = 'h'; key = dx > 0 ? 'Right' : 'Left'; }
    else {
      throw fail(
        `focus: ${describe} is aligned with focus but never received it after ${presses} press(es) ` +
        `(focused: ${cur.subtype}#${cur.id || '?'})`, { selector });
    }

    await device.keypress(key); presses++;
    tree = await sg.waitForSettle(device, settle);
    if (targetFocused(tree.roots, selector)) return { presses };

    const next = focusedNode(tree.roots);
    if (!next || sameNode(next, cur)) {
      // Focus didn't move → we're at an edge on this axis; try the other one.
      exhausted[axis] = true;
      if (exhausted.h && exhausted.v) {
        throw fail(
          `focus: reached an edge without focusing ${describe} after ${presses} press(es) ` +
          `(focused: ${cur.subtype}#${cur.id || '?'})`, { selector });
      }
      continue;
    }

    // Focus moved: measure convergence and re-open both axes for the new position.
    const nd = distance(center(next.bounds), center(target.bounds));
    stuck = nd >= lastDist ? stuck + 1 : 0;
    lastDist = nd;
    exhausted.h = false; exhausted.v = false;
    if (stuck >= 3) {
      throw fail(
        `focus: not converging on ${describe} (distance stopped decreasing) after ${presses} press(es) ` +
        `(focused: ${next.subtype}#${next.id || '?'})`, { selector });
    }
  }
  throw fail(`focus: gave up after ${maxPresses} presses without focusing ${describe}`, { selector });
}

module.exports = { focusTo, focusedNode, targetFocused, subtreeFocused, sameNode, center, distance };
