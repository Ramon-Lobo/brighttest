<script>
  import { studio } from './store.svelte.js';
  import { matchesSel as matches } from './match.js';
  let { shotSrc, oncontext } = $props();

  const drawable = (n) => n.abs && n.abs.w > 0 && n.abs.h > 0 && n.visible !== false &&
    (studio.showAll || n.id || n.text || n.focusable || n.focused);
</script>

<div class="monitor" role="presentation" onclick={() => (studio.selectedPath = null)}>
  <div class="bezel">
    <img src={shotSrc} alt="live device screen" draggable="false" />
    <svg viewBox="0 0 {studio.scene.w} {studio.scene.h}" preserveAspectRatio="none">
      {#each studio.nodes as n (n.path)}
        {#if drawable(n)}
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
          <rect
            x={n.abs.x} y={n.abs.y} width={n.abs.w} height={n.abs.h}
            class="box"
            class:idd={n.id}
            class:focused={n.focused}
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
  .box.focused { stroke: var(--color-amber); stroke-width: 2; }
  .box.hover { fill: rgba(124,108,255,.14); stroke: var(--color-violet); stroke-width: 2; }
  .box.sel { fill: rgba(124,108,255,.2); stroke: var(--color-violet); stroke-width: 2.5; }
  .box.probe { fill: rgba(124,108,255,.12); stroke: var(--color-violet); stroke-width: 2; stroke-dasharray: 6 4; }
  .box.hot { fill: rgba(255,194,75,.16); stroke: var(--color-amber); stroke-width: 3; animation: pulse 1s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { fill: rgba(255,194,75,.06); } 50% { fill: rgba(255,194,75,.24); } }
</style>
