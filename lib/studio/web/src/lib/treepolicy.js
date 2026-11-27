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

// Screenshots on demand (design 7.1, 8). The picture is read only when something may have changed: after a key press,
// after the tree changed, at most every IDLE_MS while nothing happens (a catch-all for changes Studio cannot see), and
// when the user presses refresh. A screenshot costs the device about a second, so shots are never closer than MIN_GAP_MS.
export const IDLE_MS = 5000;
export const MIN_GAP_MS = 1000;
export const PRESS_SETTLE_MS = 400; // wait this long after the newest press or change: the screen needs a moment to draw, and a burst of presses is one wait
export const MAX_DEFER_MS = 1500;  // but never hold a changed picture back longer than this, even while keys keep coming

// A cheap fingerprint of the tree: what is on screen, where, and what is focused. Equal fingerprints mean "no change".
export function treeSignature(nodes) {
  if (!Array.isArray(nodes)) return '';
  let h = 0;
  const mix = (s) => { for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0; };
  for (const n of nodes) {
    const r = n.vis || n.abs || {};
    mix(`${n.path}|${n.id || ''}|${n.text || ''}|${n.focused ? 1 : 0}|${n.onScreen === false ? 0 : 1}|${r.x},${r.y},${r.w},${r.h};`);
  }
  return `${nodes.length}:${h}`;
}

// Decide whether to take a screenshot now.
//   now, lastShotAt: ms clock values (lastShotAt 0 = never).
//   dirtyAt: when the newest press or tree change not yet covered by a shot happened (null = none).
//   dirtySince: when the oldest such change happened (defaults to dirtyAt); bounds the wait with MAX_DEFER_MS.
//   forced: the refresh button.
// Returns { take, reason, waitMs }: waitMs is how long until the next decision can say take (0 when take is true).
export function shotDecision({ now, lastShotAt = 0, dirtyAt = null, dirtySince = dirtyAt, forced = false, idleMs = IDLE_MS, minGapMs = MIN_GAP_MS, settleMs = PRESS_SETTLE_MS, maxDeferMs = MAX_DEFER_MS }) {
  if (forced) return { take: true, reason: 'refresh', waitMs: 0 };
  if (!lastShotAt) return { take: true, reason: 'first', waitMs: 0 };
  const gapAt = lastShotAt + minGapMs;
  let dueAt, reason;
  if (dirtyAt != null) { dueAt = Math.max(Math.min(dirtyAt + settleMs, dirtySince + maxDeferMs), gapAt); reason = 'change'; }
  else { dueAt = lastShotAt + idleMs; reason = 'idle'; }
  return now >= dueAt ? { take: true, reason, waitMs: 0 } : { take: false, reason, waitMs: dueAt - now };
}

// "just now", "3 s ago", "2 min ago" for the monitor; '' when there is no shot yet.
export function formatShotAge(ms) {
  if (ms == null || !(ms >= 0)) return '';
  const s = Math.floor(ms / 1000);
  if (s < 2) return 'just now';
  if (s < 60) return `${s} s ago`;
  return `${Math.floor(s / 60)} min ago`;
}
