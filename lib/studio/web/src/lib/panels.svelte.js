// Panel pop-out store (tiles option B: every inspector panel is its own tile, ADR 0050).
// A panel is "popped out" while its tile is shown (open or minimized) and "docked" while the tile is hidden. Which one
// is NOT stored here: it is read from studio.layout, the single source. This store keeps only the panel order (docked
// panels list most recently docked first), saved in the layout document (storage v2) under `panels.order`.
import { studio, commitLayout } from './store.svelte.js';
import { setState, loadPanelOrder, cleanOrder, save } from './layout.js';
import { inspectRegistry, INSPECT_KEY } from './tiles.js';

export const PANELS = ['node', 'tree', 'selector', 'state', 'actions', 'network'];

const store = typeof localStorage === 'undefined' ? null : localStorage;

export const panels = $state({ order: store ? loadPanelOrder(store, INSPECT_KEY, PANELS) : PANELS.slice() });

export function isPoppedOut(id) {
  const t = studio.layout.find((o) => o.id === id);
  return !!t && t.state !== 'hidden';
}

// Docked panels, in panel order.
export function dockedPanels() {
  return panels.order.filter((id) => !isPoppedOut(id));
}

export function popOut(id) {
  if (!PANELS.includes(id)) return;
  const t = studio.layout.find((o) => o.id === id);
  if (t && t.state !== 'open') commitLayout(setState(studio.layout, id, 'open', inspectRegistry)); // back to its old slot if free
}

export function dock(id) {
  if (!PANELS.includes(id) || !isPoppedOut(id)) return;
  panels.order = cleanOrder([id, ...panels.order], PANELS);
  commitLayout(setState(studio.layout, id, 'hidden', inspectRegistry));
  if (store) save(store, INSPECT_KEY, studio.layout, inspectRegistry, { order: panels.order.slice() });
}
