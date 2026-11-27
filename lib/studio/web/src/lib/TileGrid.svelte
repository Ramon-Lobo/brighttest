<script>
  // The Inspect tile grid: 12 columns, 32 px rows (layout.js). Tiles are placed with CSS grid; pointer travel is turned
  // into whole cells by drag.js. During a drag a ghost follows the pointer and a placeholder shows the target cell;
  // the layout is committed (and saved) once, on drop.
  import { onMount, tick } from 'svelte';
  import Tile from './Tile.svelte';
  import { stackOrder, setState } from './layout.js';
  import { metrics, isNarrow, pastThreshold, dragPreview, stepTile, keyStep } from './drag.js';

  let { layout, registry, oncommit, content } = $props();

  let gridEl;
  let narrow = $state(false);
  let drag = $state(null); // { id, mode, sx, sy, start, m, dx, dy, active, preview, ghost, key }
  let live = $state('');

  const shown = $derived(drag?.active ? drag.preview : layout);
  const tileOf = (id) => shown.find((t) => t.id === id);
  const specOf = (id) => registry.tiles[id] || {};
  // Visible tiles in reading order, then hidden tiles that must stay mounted (the flow editor).
  const ids = $derived([
    ...stackOrder(shown),
    ...shown.filter((t) => t.state === 'hidden' && specOf(t.id).keepMounted).map((t) => t.id),
  ]);
  const ghostTile = $derived(drag?.active && drag.mode === 'move' ? shown.find((t) => t.id === drag.id) : null);

  onMount(() => {
    const ro = new ResizeObserver(() => { const w = gridEl.clientWidth; if (w > 0) narrow = isNarrow(w); });
    ro.observe(gridEl);
    return () => { ro.disconnect(); detach(); };
  });

  function attach() {
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', onEsc, true);
  }
  function detach() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', onEsc, true);
    document.body.style.userSelect = '';
  }

  function down(e, id, mode) {
    if (narrow || (e.button != null && e.button > 0) || drag) return;
    const t = layout.find((o) => o.id === id);
    if (!t) return;
    const r = e.currentTarget.closest('.tile').getBoundingClientRect();
    drag = {
      id, mode, sx: e.clientX, sy: e.clientY, dx: 0, dy: 0, active: false, key: '', preview: layout,
      start: { x: t.x, y: t.y, w: t.w, h: t.h },
      m: metrics(gridEl.clientWidth),
      ghost: { left: r.left, top: r.top, width: r.width, height: r.height },
    };
    document.body.style.userSelect = 'none';
    attach();
  }
  function onMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.active && !pastThreshold(dx, dy)) return;
    const cx = Math.round(dx / drag.m.stepX), cy = Math.round(dy / drag.m.stepY);
    const key = `${cx},${cy}`;
    drag = {
      ...drag, active: true, dx, dy, key,
      // Recompute the layout only when the target cell changes.
      preview: key === drag.key && drag.active ? drag.preview : dragPreview(layout, drag.id, drag.start, drag.mode, drag.m, dx, dy, registry),
    };
  }
  function onUp() {
    const d = drag;
    drag = null;
    detach();
    if (d?.active) { oncommit(d.preview); say(d.id, d.preview); }
  }
  function cancel() { drag = null; detach(); }
  function onEsc(e) { if (e.key === 'Escape' && drag) { e.stopPropagation(); cancel(); } }

  function say(id, next, what = '') {
    const t = next.find((o) => o.id === id);
    if (!t) return;
    live = what || `${specOf(id).title} tile, column ${t.x + 1}, row ${t.y + 1}, ${t.w} by ${t.hOpen || t.h}`;
  }
  async function action(id, a) {
    let next = layout;
    if (a === 'min') next = setState(layout, id, 'min', registry);
    else if (a === 'open') next = setState(layout, id, 'open', registry);
    else if (a === 'hide') next = setState(layout, id, 'hidden', registry);
    else {
      const step = { left: keyStep('ArrowLeft'), right: keyStep('ArrowRight'), up: keyStep('ArrowUp'), down: keyStep('ArrowDown'),
        wider: keyStep('ArrowRight', true), narrower: keyStep('ArrowLeft', true), taller: keyStep('ArrowDown', true), shorter: keyStep('ArrowUp', true) }[a];
      next = stepTile(layout, id, step, registry);
    }
    oncommit(next);
    if (a === 'hide') { live = `${specOf(id).title} tile hidden`; await tick(); document.querySelector('[data-testid="tiles-menu"]')?.focus(); }
    else if (a === 'min' || a === 'open') live = `${specOf(id).title} tile ${a === 'min' ? 'minimized' : 'restored'}`;
    else say(id, next);
  }
  function showAll() {
    let next = layout;
    for (const t of layout) if (t.state === 'hidden') next = setState(next, t.id, 'open', registry);
    oncommit(next);
  }
</script>

<div class="grid" class:narrow class:dragging={drag?.active} role="group" aria-label="Inspect layout" data-testid="layout-grid" bind:this={gridEl}>
  {#each ids as id (id)}
    {@const t = tileOf(id)}
    {#if t}
      <Tile tile={t} title={specOf(id).title} keepMounted={!!specOf(id).keepMounted} {narrow} dragging={ghostTile?.id === id}
        {content} onhandledown={(e, i) => down(e, i, 'move')} ongripdown={(e, i) => down(e, i, 'resize')} onaction={action} />
    {/if}
  {/each}
  {#if ghostTile}
    <div class="placeholder" data-testid="layout-placeholder" aria-hidden="true"
      style="grid-column: {ghostTile.x + 1} / span {ghostTile.w}; grid-row: {ghostTile.y + 1} / span {ghostTile.h};"></div>
  {/if}
  {#if stackOrder(layout).length === 0 && !drag}
    <div class="empty" data-testid="layout-empty" role="status">
      <p>All tiles are hidden.</p>
      <button data-testid="layout-empty-show" onclick={showAll}>Show tiles</button>
    </div>
  {/if}
</div>

{#if drag?.active && drag.mode === 'move'}
  <div class="ghost" aria-hidden="true"
    style="left: {drag.ghost.left + drag.dx}px; top: {drag.ghost.top + drag.dy}px; width: {drag.ghost.width}px; height: {Math.min(drag.ghost.height, 120)}px;">
    {specOf(drag.id).title}
  </div>
{/if}
<div class="sr" data-testid="layout-live" role="status" aria-live="polite">{live}</div>

<style>
  .grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); grid-auto-rows: 32px; gap: 12px; align-items: stretch; }
  .grid.narrow { grid-template-columns: minmax(0, 1fr); }
  .grid.dragging { cursor: grabbing; }
  .placeholder { border: 2px dashed var(--color-violet); border-radius: 12px; background: rgba(124,108,255,.08); pointer-events: none; }
  .ghost { position: fixed; z-index: 100; pointer-events: none; box-sizing: border-box; padding: 8px 12px; font-size: 11px; letter-spacing: .1em;
    text-transform: uppercase; color: var(--color-text); background: rgba(124,108,255,.25); border: 1px solid var(--color-violet); border-radius: 12px; }
  .empty { grid-column: 1 / -1; grid-row: 1 / span 6; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--color-haze); }
  .empty button { background: var(--color-violet); color: #0c0e14; font-weight: 700; border: none; border-radius: 8px; padding: 7px 18px; cursor: pointer; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
