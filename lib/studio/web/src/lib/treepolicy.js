// When Studio reads the SceneGraph tree, and how often. Pure, so it is unit tested.
// The overlay draws from the tree; with it off, only an open panel that shows tree data needs reads.
export const FAST_MS = 300;
export const PANEL_MS = 1000;

const PICTURE_PAGES = ['inspect', 'record'];
const TREE_PANELS = ['node', 'tree', 'selector'];

// Panels on screen: the ids of the open tiles that are inspector panels (Inspect layout, tiles option B).
export const PANEL_IDS = ['node', 'tree', 'selector', 'state', 'actions', 'network'];
export function visiblePanels(layout) {
  return (layout || []).filter((t) => t.state === 'open' && PANEL_IDS.includes(t.id)).map((t) => t.id);
}
export function monitorVisible(layout) {
  return (layout || []).some((t) => t.id === 'monitor' && t.state === 'open');
}
// One-release shim: callers that still pass a single active `tab` get it as the only visible panel.
const panelsOf = ({ visiblePanels: v, tab }) => (Array.isArray(v) ? v : tab ? [tab] : []);

// A panel needs the tree only on the Inspect page (the other pages hide the panels): the Node, Tree and
// Selector panels, or the State panel while it falls back to the read-only app state from the tree.
export function panelNeedsTree({ page, stateFallback, ...rest }) {
  if (page !== 'inspect') return false;
  const v = panelsOf(rest);
  return TREE_PANELS.some((id) => v.includes(id)) || (v.includes('state') && !!stateFallback);
}

// `monitor` is whether the monitor tile is on screen (default true): the overlay is drawn on it, so a hidden or
// minimized monitor stops the overlay's tree reads. Record always has its own monitor.
export function treeNeeded({ overlay, page, stateFallback, live, sim, lease, monitor = true, ...rest }) {
  if (sim || lease || !live || !PICTURE_PAGES.includes(page)) return false;
  const overlayOn = !!overlay && (page === 'record' || monitor);
  return overlayOn || panelNeedsTree({ page, stateFallback, ...rest });
}

// Screenshots are polled only while a monitor is on screen.
export function shotNeeded({ page, live, sim, lease, monitor = true }) {
  if (sim || lease || !live || !PICTURE_PAGES.includes(page)) return false;
  return page === 'record' || !!monitor;
}

export function treeIntervalMs({ overlay, monitor = true }) {
  return overlay && monitor ? FAST_MS : PANEL_MS;
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
