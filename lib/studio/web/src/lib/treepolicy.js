// When Studio reads the SceneGraph tree, and how often. Pure, so it is unit tested.
// The overlay draws from the tree; with it off, only an open panel that shows tree data needs reads.
export const FAST_MS = 300;
export const PANEL_MS = 1000;

const PICTURE_PAGES = ['inspect', 'record'];
const TREE_TABS = ['node', 'tree', 'selector'];

// A panel needs the tree only on the Inspect page (the other pages hide the panels): the Node, Tree and
// Selector tabs, or the State tab while it falls back to the read-only app state from the tree.
export function panelNeedsTree({ page, tab, stateFallback }) {
  if (page !== 'inspect') return false;
  return TREE_TABS.includes(tab) || (tab === 'state' && !!stateFallback);
}

export function treeNeeded({ overlay, page, tab, stateFallback, live, sim, lease }) {
  if (sim || lease || !live || !PICTURE_PAGES.includes(page)) return false;
  return !!overlay || panelNeedsTree({ page, tab, stateFallback });
}

export function treeIntervalMs({ overlay }) {
  return overlay ? FAST_MS : PANEL_MS;
}

// Storage: {"v":1,"on":false}. Missing or unreadable means on.
export const OVERLAY_KEY = 'bt.studio.overlay';
export function loadOverlay(storage) {
  try {
    const v = JSON.parse(storage.getItem(OVERLAY_KEY));
    return !(v && v.v === 1 && v.on === false);
  } catch { return true; }
}
export function saveOverlay(storage, on) {
  try { storage.setItem(OVERLAY_KEY, JSON.stringify({ v: 1, on: !!on })); } catch { /* private mode: not remembered */ }
}
