// Shared reactive studio state (Svelte 5 runes in a module).
export const studio = $state({
  device: null,          // { model, firmware, ... }
  scene: { w: 1920, h: 1080 },
  nodes: [],             // resolved tree from /api/tree
  appState: null,        // { present, state, error } from the app's __bt_state snapshot
  selectedPath: null,    // pinned node path
  hoverPath: null,       // hovered node path
  probe: null,           // selector being tested in the playground (highlighted on the monitor)
  runHighlight: null,    // selector of the step currently running
  live: true,
  showAll: false,        // include nodes with no id/text/focus (structural containers)
  showOffscreen: false,  // include nodes the device isn't drawing (hidden, transparent, clipped away)
  status: '',
  lease: null,           // set while another holder has the device (423): { error, lease }
  page: 'inspect',
});

export function selectedNode() {
  return studio.nodes.find((n) => n.path === studio.selectedPath) || null;
}
