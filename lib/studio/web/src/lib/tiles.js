// Tile registry for the Inspect page (data only). Tiles option B: every inspector panel is its own tile.
// Bump `version` when a tile is added or removed, or when a minimum size grows; layout.js migrates saved layouts.
// `keepMounted`: the content stays mounted while the tile is minimized or hidden (CodeMirror keeps undo and cursor).
// Sizes are grid units: 12 columns, one row = 32 px.

export const INSPECT_KEY = 'bt.studio.layout.inspect'

export const inspectRegistry = {
  version: 1,
  tiles: {
    monitor: { title: 'Program monitor', minW: 3, minH: 5, default: { x: 6, y: 0, w: 6, h: 11 }, newState: 'open' },
    flow: { title: 'Flow', keepMounted: true, minW: 3, minH: 6, default: { x: 0, y: 0, w: 6, h: 20 }, newState: 'open' },
    remote: { title: 'Remote', minW: 2, minH: 7, default: { x: 6, y: 11, w: 2, h: 9 }, newState: 'open' },
    node: { title: 'Node', minW: 3, minH: 6, default: { x: 8, y: 11, w: 4, h: 9 }, newState: 'open' },
    tree: { title: 'Tree', minW: 3, minH: 6, default: { x: 0, y: 20, w: 4, h: 9 }, newState: 'open' },
    selector: { title: 'Selector', minW: 3, minH: 6, default: { x: 4, y: 20, w: 4, h: 9 }, newState: 'open' },
    state: { title: 'State', minW: 3, minH: 6, default: { x: 8, y: 20, w: 4, h: 9 }, newState: 'open' },
    actions: { title: 'Actions', minW: 3, minH: 6, default: { x: 0, y: 29, w: 6, h: 8 }, newState: 'open' },
    network: { title: 'Network', minW: 3, minH: 6, default: { x: 6, y: 29, w: 6, h: 8 }, newState: 'open' },
  },
  // Named presets: tile id -> placement. A tile missing from a preset is hidden.
  presets: {
    'monitor-info': {
      monitor: { x: 0, y: 0, w: 7, h: 14, state: 'open' },
      node: { x: 7, y: 0, w: 5, h: 7, state: 'open' },
      state: { x: 7, y: 7, w: 5, h: 7, state: 'open' },
    },
  },
}

export default inspectRegistry
