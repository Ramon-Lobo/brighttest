// Shared reactive studio state (Svelte 5 runes in a module).
import { loadOverlay } from './treepolicy.js';

export const studio = $state({
  device: null,          // { model, firmware, ... }
  scene: { w: 1920, h: 1080 },
  nodes: [],             // resolved tree from /api/tree
  appState: null,        // { present, state, error } from the app's __bt_state snapshot
  agent: null,           // { present, seq, error, layers: {name: {state, truncated}} } from __bt_agent (read-only)
  selectedPath: null,    // pinned node path
  hoverPath: null,       // hovered node path
  probe: null,           // selector being tested in the playground (highlighted on the monitor)
  runHighlight: null,    // selector of the step currently running
  live: true,
  overlay: loadOverlay(typeof localStorage === 'undefined' ? null : localStorage), // node outlines on the picture; remembered per browser
  stateFallback: false,  // the State tab is showing the read-only app state from the tree
  showAll: false,        // include nodes with no id/text/focus (structural containers)
  showOffscreen: false,  // include nodes the device isn't drawing (hidden, transparent, clipped away)
  status: '',
  leaseInfo: null,       // last /api/lease status, always kept fresh (the header badge and queue view)
  lease: null,           // set while another holder has the device (423): { error, lease }
  page: 'inspect',
});

export function selectedNode() {
  return studio.nodes.find((n) => n.path === studio.selectedPath) || null;
}
