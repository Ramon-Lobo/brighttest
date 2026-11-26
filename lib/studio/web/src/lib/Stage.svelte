<script>
  import { studio } from './store.svelte.js';
  import { matchesSel as matches } from './match.js';
  let { shotSrc, oncontext } = $props();

  // sgnodes/all dumps the whole tree, so most nodes with bounds are NOT on screen — hidden drawers,
  // preloaded sibling screens, ArrayGrid items scrolled out of view. The server derives `onScreen`
  // (inherited visible + opacity, intersected with the viewport and every clipping ancestor) and `vis`
  // (the actually-visible sub-rect); draw against those, not raw `abs`.
  //
  // Traces persisted before this existed have neither field, so fall back to the node's own visible flag
  // rather than showing an empty overlay when replaying an old run.
  const legacy = (n) => n.onScreen === undefined;
  const rendered = (n) => (legacy(n) ? n.visible !== false : n.onScreen);

  // Keep a node visible regardless of clipping when the user is specifically pointing at it: a selector
  // that matches something off-screen must still highlight, or the playground looks broken.
  const forced = (n) =>
    n.path === studio.selectedPath || matches(n, studio.probe) || matches(n, studio.runHighlight);

  // Clipped rect normally; the full rect when we're deliberately showing something off-screen.
  const rectOf = (n) => (rendered(n) && !studio.showOffscreen ? n.vis || n.abs : n.abs || n.vis);

  const drawable = (n) => {
    const r = rectOf(n);
    if (!r || !(r.w > 0) || !(r.h > 0)) return false;
    if (!rendered(n) && !studio.showOffscreen && !forced(n)) return false;
    return studio.showAll || n.id || n.text || n.focusable || n.focused;
  };
</script>

<div class="monitor" data-testid="monitor-stage" role="presentation" onclick={() => { if (studio.overlay) studio.selectedPath = null; }}>
  <div class="bezel">
    <img src={shotSrc} data-testid="monitor-screenshot" alt="live device screen" draggable="false" />
    {#if studio.overlay}
    <svg viewBox="0 0 {studio.scene.w} {studio.scene.h}" preserveAspectRatio="none" data-testid="monitor-overlay" aria-label="node overlay">
      {#each studio.nodes as n (n.path)}
        {#if drawable(n)}
          {@const r = rectOf(n)}
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
          <rect
            x={r.x} y={r.y} width={r.w} height={r.h}
            class="box"
            class:idd={n.id}
            class:focused={n.focused}
            class:offscreen={!rendered(n)}
            class:approx={n.posExact === false}
            class:sel={n.path === studio.selectedPath}
            class:hover={n.path === studio.hoverPath}
            class:probe={matches(n, studio.probe)}
            class:hot={matches(n, studio.runHighlight)}
            onmouseenter={() => (studio.hoverPath = n.path)}
            onmouseleave={() => { if (studio.hoverPath === n.path) studio.hoverPath = null; }}
            onclick={(e) => { e.stopPropagation(); studio.selectedPath = n.path; }}
            oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); studio.selectedPath = n.path; oncontext?.(n, e.clientX, e.clientY); }}
            role="button" tabindex="-1"
          ></rect>
        {/if}
      {/each}
    </svg>
    {/if}
  </div>
</div>

<style>
  .monitor { width: 100%; }
  .bezel {
    position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000;
    border-radius: 14px; padding: 10px; border: 1px solid var(--color-line2);
    box-shadow: 0 24px 60px rgba(0,0,0,.55), inset 0 0 0 1px rgba(255,255,255,.02);
  }
  .bezel img { position: absolute; inset: 10px; width: calc(100% - 20px); height: calc(100% - 20px); object-fit: fill; border-radius: 6px; }
  svg { position: absolute; inset: 10px; width: calc(100% - 20px); height: calc(100% - 20px); }

  .box { fill: transparent; stroke: rgba(138,144,166,.28); stroke-width: 1; vector-effect: non-scaling-stroke; cursor: pointer; transition: fill .12s ease; }
  .box.idd { stroke: rgba(124,108,255,.5); }
  /* Not being drawn by the device: dashed and dim, so it reads as "present in the tree, not on screen". */
  .box.offscreen { stroke: rgba(138,144,166,.3); stroke-dasharray: 3 5; }
  /* Origin not resolvable: the node sits under an ArrayGrid item wrapper, and sgnodes does not report that
     wrapper's offset. The box is at the grid's origin, not the item's — flagged so it can't mislead. */
  .box.approx { stroke: rgba(255,194,75,.34); stroke-dasharray: 2 6; }
  .box.focused { stroke: var(--color-amber); stroke-width: 2; }
  .box.hover { fill: rgba(124,108,255,.14); stroke: var(--color-violet); stroke-width: 2; }
  .box.sel { fill: rgba(124,108,255,.2); stroke: var(--color-violet); stroke-width: 2.5; }
  .box.probe { fill: rgba(124,108,255,.12); stroke: var(--color-violet); stroke-width: 2; stroke-dasharray: 6 4; }
  .box.hot { fill: rgba(255,194,75,.16); stroke: var(--color-amber); stroke-width: 3; animation: pulse 1s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { fill: rgba(255,194,75,.06); } 50% { fill: rgba(255,194,75,.24); } }
</style>
