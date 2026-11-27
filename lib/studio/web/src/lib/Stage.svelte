<script>
  import { studio } from './store.svelte.js';
  import { matchesSel as matches } from './match.js';
  import { formatShotAge } from './treepolicy.js';
  import { cropTransform, boxAgeText } from './feed.js';
  // fit 'width' (Record): the box takes the width and grows in height. 'contain' (tiles): the largest 16:9 box that
  // fits the container, letterboxed; the picture and the overlay fill that one box, so they stay aligned at any size.
  // source: { kind: 'feed', stream, rect } shows a live capture-card video instead of the screenshot (shotSrc).
  // treeAt: when the boxes were read; settling: a press is still moving things; aid: calibration guides.
  let { shotSrc, oncontext, fit = 'width', shotAt = 0, onrefresh, source = null, treeAt = 0, settling = false, aid = false } = $props();
  const isFeed = $derived(source?.kind === 'feed');

  // The age of the shown picture, redrawn once a second so a stale monitor is visible (four times a second for a feed's box age).
  let now = $state(Date.now());
  $effect(() => { const t = setInterval(() => { now = Date.now(); }, isFeed ? 250 : 1000); return () => clearInterval(t); });
  const age = $derived(shotAt ? formatShotAge(Math.max(0, now - shotAt)) : '');
  const boxAge = $derived(isFeed && treeAt ? boxAgeText(Math.max(0, now - treeAt)) : '');
  // The stream is set as a property, not an attribute.
  function attach(node, stream) {
    node.srcObject = stream;
    return { update(s) { node.srcObject = s; }, destroy() { node.srcObject = null; } };
  }
  const focusedNodes = $derived(studio.nodes.filter((n) => n.focused && n.abs));

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

<div class="monitor" class:contain={fit === 'contain'} data-testid="monitor-stage" role="presentation" onclick={() => { if (studio.overlay) studio.selectedPath = null; }}>
  <div class="bezel">
    {#if isFeed}
      <div class="vwrap">
        <!-- svelte-ignore a11y_media_has_caption -->
        <video autoplay muted playsinline data-testid="monitor-video" aria-label="live capture-card feed" use:attach={source.stream} style="transform: {cropTransform(source.rect)}"></video>
      </div>
    {:else}
    <img src={shotSrc} data-testid="monitor-screenshot" alt="live device screen" draggable="false" />
    {/if}
    {#if studio.overlay || aid}
    <svg viewBox="0 0 {studio.scene.w} {studio.scene.h}" preserveAspectRatio="none" data-testid="monitor-overlay" class:settling={isFeed && settling} aria-label="node overlay">
      {#if aid}
        <rect class="aidframe" data-testid="feed-aid-frame" x="0" y="0" width={studio.scene.w} height={studio.scene.h}></rect>
        {#each focusedNodes as n (n.path)}<rect class="aidnode" x={n.abs.x} y={n.abs.y} width={n.abs.w} height={n.abs.h}></rect>{/each}
      {/if}
      {#if studio.overlay}
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
      {/if}
    </svg>
    {/if}
    {#if isFeed}
    <div class="shotbar">
      {#if settling}<span class="shotage" data-testid="monitor-settling" role="status">settling</span>{/if}
      {#if boxAge}<span class="shotage" data-testid="monitor-box-age" role="status">{boxAge}</span>{/if}
    </div>
    {:else if onrefresh}
    <div class="shotbar">
      {#if age}<span class="shotage" data-testid="monitor-shot-age" role="status">{age}</span>{/if}
      <button type="button" class="shotrefresh" data-testid="monitor-refresh" title="Take a new screenshot now" aria-label="Refresh screenshot" onclick={(e) => { e.stopPropagation(); onrefresh(); }}>refresh</button>
    </div>
    {/if}
  </div>
</div>

<style>
  .shotbar { position: absolute; right: 18px; bottom: 16px; display: flex; gap: 6px; align-items: center; font-size: 11px; z-index: 2; }
  .shotage { background: rgba(0,0,0,.6); color: #cfd3e4; padding: 2px 6px; border-radius: 4px; }
  .shotrefresh { background: rgba(0,0,0,.6); color: #cfd3e4; border: 1px solid var(--color-line2); border-radius: 4px; padding: 2px 8px; font-size: 11px; cursor: pointer; }
  .shotrefresh:hover { color: #fff; }
  .monitor { width: 100%; }
  .monitor.contain { height: 100%; container-type: size; display: flex; }
  .monitor.contain .bezel { width: min(100cqw, calc(100cqh * 16 / 9)); margin: auto; flex: none; }
  .bezel {
    position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000;
    border-radius: 14px; padding: 10px; border: 1px solid var(--color-line2);
    box-shadow: 0 24px 60px rgba(0,0,0,.55), inset 0 0 0 1px rgba(255,255,255,.02);
  }
  .vwrap { position: absolute; inset: 10px; overflow: hidden; border-radius: 6px; }
  .vwrap video { width: 100%; height: 100%; object-fit: fill; transform-origin: 0 0; display: block; }
  svg.settling .box { opacity: .35; }
  .aidframe { fill: none; stroke: #4cd7ff; stroke-width: 1.5; stroke-dasharray: 8 6; vector-effect: non-scaling-stroke; pointer-events: none; }
  .aidnode { fill: none; stroke: #ff5ca8; stroke-width: 1.5; vector-effect: non-scaling-stroke; pointer-events: none; }
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
