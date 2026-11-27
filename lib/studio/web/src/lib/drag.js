// Pointer-to-cell maths for the tile grid. Pure: no DOM. TileGrid measures the grid once at drag start and feeds the
// numbers here; the layout itself is changed only through layout.js.
import { COLS, GAP, ROW_H, move, resize } from './layout.js'

export const NARROW_PX = 960 // under this the grid is one column and drag and resize are off
export const THRESHOLD_PX = 4 // pointer travel that separates a click from a drag

export function isNarrow(width) { return width > 0 && width < NARROW_PX }
export function pastThreshold(dx, dy) { return Math.hypot(dx, dy) >= THRESHOLD_PX }

// Cell pitch for a grid of the given content width (12 columns, 12 px gap, 32 px rows).
export function metrics(width) {
  const colW = Math.max(1, (width - GAP * (COLS - 1)) / COLS)
  return { colW, stepX: colW + GAP, stepY: ROW_H + GAP }
}

// Pointer travel in pixels to whole cells.
export function cellDelta(m, dx, dy) {
  return { cx: Math.round(dx / m.stepX), cy: Math.round(dy / m.stepY) }
}

// The layout while a drag is under way: `start` is the tile as it was at pointer down, `mode` is 'move' or 'resize'.
// Both clamp (bounds, minimum sizes) and settle through layout.js, so the result is always a valid layout.
export function dragPreview(layout, id, start, mode, m, dx, dy, registry) {
  const { cx, cy } = cellDelta(m, dx, dy)
  return mode === 'resize'
    ? resize(layout, id, start.w + cx, start.h + cy, registry)
    : move(layout, id, start.x + cx, start.y + cy, registry)
}

// Keyboard and menu steps: one cell per press; Shift resizes.
export function keyStep(key, shift) {
  const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[key]
  if (!d) return null
  return shift ? { dx: 0, dy: 0, dw: d[0], dh: d[1] } : { dx: d[0], dy: d[1], dw: 0, dh: 0 }
}

// Apply one step to a tile through layout.js.
export function stepTile(layout, id, step, registry) {
  const t = layout.find((o) => o.id === id)
  if (!t || !step) return layout
  if (step.dw || step.dh) return resize(layout, id, t.w + step.dw, (t.hOpen || t.h) + step.dh, registry)
  return move(layout, id, t.x + step.dx, t.y + step.dy, registry)
}
