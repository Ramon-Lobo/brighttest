// Pure tile-grid layout engine (ADR 0050). No DOM, no framework. Every function returns a new layout (an array of
// tiles); inputs are never mutated.
// Tile: { id, x, y, w, h, state, hOpen? }  state = 'open' | 'min' | 'hidden'.
// A minimized tile has h = 1 and keeps its open height in hOpen. A hidden tile keeps its last place and size and is
// ignored by collision and compaction.

export const COLS = 12
export const ROW_H = 32
export const GAP = 12
export const STORAGE_V = 1
const STATES = ['open', 'min', 'hidden']

const int = (n, d) => (Number.isFinite(n) ? Math.round(n) : d)
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), Math.max(lo, hi))
const shown = (t) => t.state !== 'hidden'
const byYX = (a, b) => a.y - b.y || a.x - b.x
const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const copy = (layout) => layout.map((t) => ({ ...t }))
const spec = (registry, id) => registry && registry.tiles && registry.tiles[id]

function openH(t) { return t.hOpen || t.h }

// Clamp one tile to bounds and minimum sizes (no collision handling).
function fit(t, registry) {
  const s = spec(registry, t.id) || {}
  const d = s.default || {}
  const minW = s.minW || 1
  const minH = s.minH || 1
  const out = { ...t }
  out.state = STATES.includes(out.state) ? out.state : 'open'
  out.w = clamp(int(out.w, d.w || minW), minW, COLS)
  out.x = clamp(int(out.x, d.x || 0), 0, COLS - out.w)
  out.y = Math.max(0, int(out.y, d.y || 0))
  const hasOpen = out.state === 'min' || (out.state === 'hidden' && out.hOpen)
  const hFull = Math.max(minH, int(hasOpen ? out.hOpen || out.h : out.h, d.h || minH))
  if (hasOpen) { out.hOpen = hFull; out.h = 1 } else { out.h = hFull; delete out.hOpen }
  return out
}

// Put tiles below anything they overlap, in y,x order, so earlier tiles win. `fixed` ids are placed first.
function resolve(tiles, fixedIds = []) {
  const vis = tiles.filter(shown)
  const fixed = vis.filter((t) => fixedIds.includes(t.id))
  const rest = vis.filter((t) => !fixedIds.includes(t.id)).sort(byYX)
  const placed = [...fixed]
  for (const t of rest) {
    let again = true
    while (again) {
      again = false
      for (const p of placed) if (hit(t, p)) { t.y = p.y + p.h; again = true }
    }
    placed.push(t)
  }
}

// Move every shown tile up while the cell above is free, in y,x order.
function compact(tiles) {
  const placed = []
  for (const t of tiles.filter(shown).sort(byYX)) {
    while (t.y > 0 && !placed.some((p) => hit({ ...t, y: t.y - 1 }, p))) t.y -= 1
    placed.push(t)
  }
}

function settle(tiles, fixedIds) {
  resolve(tiles, fixedIds)
  compact(tiles)
  return tiles
}

function pick(layout, id) {
  const i = layout.findIndex((t) => t.id === id)
  return i < 0 ? null : i
}

// First free slot for a w x h block: scan rows from the top, columns from the left.
function freeSlot(tiles, w, h, want) {
  const vis = tiles.filter(shown)
  if (want && !vis.some((p) => hit({ ...want, w, h }, p))) return { x: want.x, y: want.y }
  const bottom = vis.reduce((m, p) => Math.max(m, p.y + p.h), 0)
  for (let y = 0; y <= bottom; y++) {
    for (let x = 0; x + w <= COLS; x++) if (!vis.some((p) => hit({ x, y, w, h }, p))) return { x, y }
  }
  return { x: 0, y: bottom }
}

export function normalize(layout, registry) {
  const seen = new Set()
  const tiles = []
  for (const raw of Array.isArray(layout) ? layout : []) {
    if (!raw || typeof raw.id !== 'string' || seen.has(raw.id)) continue
    seen.add(raw.id)
    tiles.push(fit(raw, registry))
  }
  return settle(tiles)
}

export function move(layout, id, x, y, registry) {
  const tiles = copy(layout)
  const i = pick(tiles, id)
  if (i === null) return tiles
  const t = tiles[i]
  t.x = clamp(int(x, t.x), 0, COLS - t.w)
  t.y = Math.max(0, int(y, t.y))
  return settle(tiles, t.state === 'hidden' ? [] : [id])
}

export function resize(layout, id, w, h, registry) {
  const tiles = copy(layout)
  const i = pick(tiles, id)
  if (i === null) return tiles
  const s = spec(registry, id) || {}
  const t = tiles[i]
  const minW = s.minW || 1
  const minH = s.minH || 1
  t.w = clamp(int(w, t.w), minW, COLS)
  t.x = clamp(t.x, 0, COLS - t.w)
  const nh = Math.max(minH, int(h, openH(t)))
  if (t.hOpen || t.state === 'min') { t.hOpen = nh; t.h = 1 } // minimized keeps one row; only the stored height changes
  else t.h = nh
  return settle(tiles, t.state === 'hidden' ? [] : [id])
}

export function setState(layout, id, state, registry) {
  const tiles = copy(layout)
  const i = pick(tiles, id)
  if (i === null || !STATES.includes(state)) return tiles
  const t = tiles[i]
  if (t.state === state) return settle(tiles)
  const full = openH(t)
  const was = t.state
  if (state === 'open' || state === 'min') {
    t.state = state
    if (state === 'min') { t.hOpen = full; t.h = 1 } else { t.h = full; delete t.hOpen }
    if (was === 'hidden') {
      const others = tiles.filter((o) => o.id !== id)
      const slot = freeSlot(others, t.w, t.h, { x: t.x, y: t.y })
      t.x = slot.x
      t.y = slot.y
      return settle(tiles)
    }
    return settle(tiles, [id])
  }
  t.state = 'hidden' // keeps place, size and any stored open height
  return settle(tiles)
}

// Ids of the shown tiles in reading order (narrow mode stacking and tab order).
export function stackOrder(layout) {
  return layout.filter(shown).slice().sort(byYX).map((t) => t.id)
}

function fresh(id, registry) {
  const s = spec(registry, id)
  const d = s.default
  return { id, x: d.x, y: d.y, w: d.w, h: d.h, state: s.newState === 'hidden' ? 'hidden' : 'open' }
}

export function defaultLayout(registry) {
  return normalize(Object.keys(registry.tiles).map((id) => fresh(id, registry)), registry)
}

// Bring a saved tile list up to the current registry: drop unknown ids, add new ids (open ones go to the default
// place if free, else the first free slot), clamp to the current minimums, normalize.
export function migrate(saved, registry) {
  const list = Array.isArray(saved) ? saved : saved && Array.isArray(saved.tiles) ? saved.tiles : []
  const known = list.filter((t) => t && typeof t.id === 'string' && spec(registry, t.id))
  let tiles = normalize(known, registry)
  for (const id of Object.keys(registry.tiles)) {
    if (tiles.some((t) => t.id === id)) continue
    const n = fresh(id, registry)
    if (n.state === 'open') {
      const slot = freeSlot(tiles, n.w, n.h, { x: n.x, y: n.y })
      n.x = slot.x
      n.y = slot.y
    }
    tiles = normalize([...tiles, n], registry)
  }
  return tiles
}

export function preset(name, registry) {
  const p = registry.presets && registry.presets[name]
  if (!p) return defaultLayout(registry)
  const tiles = Object.keys(registry.tiles).map((id) => {
    const n = fresh(id, registry)
    return p[id] ? { ...n, ...p[id] } : { ...n, state: 'hidden' }
  })
  return normalize(tiles, registry)
}

export function load(storage, key, registry) {
  let raw = null
  try { raw = storage.getItem(key) } catch { return defaultLayout(registry) }
  if (raw == null) return defaultLayout(registry)
  let doc
  try { doc = JSON.parse(raw) } catch { return defaultLayout(registry) }
  if (!doc || doc.v !== STORAGE_V || !Array.isArray(doc.tiles)) return defaultLayout(registry)
  if (doc.reg === registry.version) {
    const tiles = normalize(doc.tiles, registry)
    const ids = Object.keys(registry.tiles)
    return ids.every((id) => tiles.some((t) => t.id === id)) ? tiles : migrate(tiles, registry)
  }
  const tiles = migrate(doc.tiles, registry)
  save(storage, key, tiles, registry)
  return tiles
}

export function save(storage, key, layout, registry) {
  try {
    storage.setItem(key, JSON.stringify({ v: STORAGE_V, reg: registry ? registry.version : 0, tiles: layout }))
    return true
  } catch { return false }
}
