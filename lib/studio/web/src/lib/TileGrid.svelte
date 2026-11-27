<script>
  // The Inspect tile grid: 12 columns, 32 px rows (layout.js). Tiles are placed with CSS grid; pointer travel is turned
  // into whole cells by drag.js. During a drag a ghost follows the pointer and a placeholder shows the target cell;
  // the layout is committed (and saved) once, on drop.
  import { onMount, tick } from 'svelte';
  import Tile from './Tile.svelte';
  import { stackOrder, setState, describeTile, sameBox } from './layout.js';
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
    if (!next.some((o) => o.id === id)) return;
    live = what || describeTile(next, id, specOf(id).title);
  }
  // Keep focus on the tile after a keyboard or menu step (keyed reordering can drop it).
  async function refocus(id, which) {
    await tick();
    document.querySelector(`[data-testid="tile-${id}-${which}"]`)?.focus();
  }
  const WORDS = { left: 'left', right: 'right', up: 'up', down: 'down', wider: 'wider', narrower: 'narrower', taller: 'taller', shorter: 'shorter' };
  function step(id, a, which) {
    const next = stepTile(layout, id, STEPS[a], registry);
    if (sameBox(layout, next, id)) say(id, next, `${specOf(id).title} tile cannot go ${WORDS[a]} any further`);
    else { oncommit(next); say(id, next); }
    refocus(id, which);
  }
  const STEPS = { left: keyStep('ArrowLeft'), right: keyStep('ArrowRight'), up: keyStep('ArrowUp'), down: keyStep('ArrowDown'),
    wider: keyStep('ArrowRight', true), narrower: keyStep('ArrowLeft', true), taller: keyStep('ArrowDown', true), shorter: keyStep('ArrowUp', true) };
  const ARROWS = { ArrowLeft: ['left', 'narrower'], ArrowRight: ['right', 'wider'], ArrowUp: ['up', 'shorter'], ArrowDown: ['down', 'taller'] };
  // Keys on a tile's handle: arrows move, Shift+arrows resize, Escape returns focus to the grid.
  function key(e, id) {
    if (narrow || drag) return;
    if (e.key === 'Escape') { gridEl.focus(); return; }
    const pair = ARROWS[e.key];
    if (!pair || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = layout.find((o) => o.id === id);
    if (!t) return;
    e.preventDefault();
    if (e.shiftKey && t.state !== 'open') { say(id, layout, `${specOf(id).title} tile is minimized, restore it to resize`); return; }
    step(id, pair[e.shiftKey ? 1 : 0], 'handle');
  }
  async function action(id, a) {
    let next = layout;
    if (a === 'min') next = setState(layout, id, 'min', registry);
    else if (a === 'open') next = setState(layout, id, 'open', registry);
    else if (a === 'hide') next = setState(layout, id, 'hidden', registry);
    else { step(id, a, 'menu'); return; }
    oncommit(next);
    if (a === 'hide') { live = `${specOf(id).title} tile hidden`; await tick(); document.querySelector('[data-testid="tiles-menu"]')?.focus(); }
    else live = `${specOf(id).title} tile ${a === 'min' ? 'minimized' : 'restored'}`;
  }
  function showAll() {
    let next = layout;
    for (const t of layout) if (t.state === 'hidden') next = setState(next, t.id, 'open', registry);
    oncommit(next);
  }
</script>

<div class="grid" class:narrow class:dragging={drag?.active} role="group" aria-label="Inspect layout" data-testid="layout-grid" tabindex="-1" bind:this={gridEl}>
  {#if narrow}
    <p class="note" data-testid="layout-narrow-note" role="note">Single-column view: moving and resizing are off because the window is narrow. Widen it to arrange tiles.</p>
  {:else}
    <span id="layout-keys-help" class="sr">Arrow keys move this tile one cell. Shift with an arrow key resizes it. Escape returns to the grid.</span>
  {/if}
  {#each ids as id (id)}
    {@const t = tileOf(id)}
    {#if t}
      <Tile tile={t} title={specOf(id).title} keepMounted={!!specOf(id).keepMounted} {narrow} dragging={ghostTile?.id === id}
        {content} onkey={key} onhandledown={(e, i) => down(e, i, 'move')} ongripdown={(e, i) => down(e, i, 'resize')} onaction={action} />
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
  .grid:focus { outline: none; }
  .note { grid-column: 1 / -1; margin: 0; font-size: 12px; color: var(--color-haze); }
  .grid.narrow { grid-template-columns: minmax(0, 1fr); }
  .grid.dragging { cursor: grabbing; }
  .placeholder { border: 2px dashed var(--color-violet); border-radius: 12px; background: rgba(124,108,255,.08); pointer-events: none; }
  .ghost { position: fixed; z-index: 100; pointer-events: none; box-sizing: border-box; padding: 8px 12px; font-size: 11px; letter-spacing: .1em;
    text-transform: uppercase; color: var(--color-text); background: rgba(124,108,255,.25); border: 1px solid var(--color-violet); border-radius: 12px; }
  .empty { grid-column: 1 / -1; grid-row: 1 / span 6; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--color-haze); }
  .empty button { background: var(--color-violet); color: #0c0e14; font-weight: 700; border: none; border-radius: 8px; padding: 7px 18px; cursor: pointer; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
