// Shared reactive studio state (Svelte 5 runes in a module).
export const studio = $state({
  device: null,          // { model, firmware, ... }
  scene: { w: 1920, h: 1080 },
  nodes: [],             // resolved tree from /api/tree
  selectedPath: null,    // pinned node path
  hoverPath: null,       // hovered node path
  probe: null,           // selector being tested in the playground (highlighted on the monitor)
  runHighlight: null,    // selector of the step currently running
  live: true,
  showAll: false,
  status: '',
  page: 'inspect',
});

export function selectedNode() {
  return studio.nodes.find((n) => n.path === studio.selectedPath) || null;
}
