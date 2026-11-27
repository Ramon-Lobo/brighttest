<script>
  // One tile of the Inspect grid: header (drag handle, minimize, menu), body (the panel), resize grip.
  // The body is unmounted while the tile is minimized, except for `keepMounted` tiles (the flow editor).
  let { tile, title, keepMounted = false, narrow = false, dragging = false, content, onhandledown, ongripdown, onaction, onkey } = $props();

  let menuOpen = $state(false);
  const open = $derived(tile.state === 'open');
  const hidden = $derived(tile.state === 'hidden');
  const pos = $derived(narrow
    ? `grid-column: 1; grid-row: auto / span ${tile.h};`
    : `grid-column: ${tile.x + 1} / span ${tile.w}; grid-row: ${tile.y + 1} / span ${tile.h};`);

  function act(a) { menuOpen = false; onaction?.(tile.id, a); }
  function onWindowDown(e) { if (menuOpen && !e.target.closest?.(`[data-menuof="${tile.id}"]`)) menuOpen = false; }
  function onKey(e) { if (e.key === 'Escape' && menuOpen) { menuOpen = false; } }
</script>

<svelte:window onpointerdown={onWindowDown} onkeydown={onKey} />

<div class="tile" class:min={tile.state === 'min'} class:hidden class:dragging class:raised={menuOpen}
  style={pos} data-testid="tile-{tile.id}" role="region" aria-label={title}>
  <header>
    <button class="handle" data-testid="tile-{tile.id}-handle" disabled={narrow} title={narrow ? title : `${title}: drag to move`}
      aria-roledescription="movable tile" aria-describedby={narrow ? undefined : 'layout-keys-help'}
      onpointerdown={(e) => onhandledown?.(e, tile.id)} onkeydown={(e) => onkey?.(e, tile.id)}>{title}</button>
    <button class="icon" data-testid="tile-{tile.id}-minimize" aria-expanded={open}
      aria-label="{open ? 'Minimize' : 'Restore'} {title}" title={open ? 'Minimize' : 'Restore'}
      onclick={() => act(open ? 'min' : 'open')}>{open ? '–' : '+'}</button>
    <span class="menuwrap" data-menuof={tile.id}>
      <button class="icon" data-testid="tile-{tile.id}-menu" aria-haspopup="menu" aria-expanded={menuOpen}
        aria-label="{title} tile menu" onclick={() => (menuOpen = !menuOpen)}>⋯</button>
      {#if menuOpen}
        <div class="menu" role="menu" aria-label="{title} tile actions">
          <button role="menuitem" onclick={() => act(open ? 'min' : 'open')}>{open ? 'Minimize' : 'Restore'}</button>
          <button role="menuitem" data-testid="tile-{tile.id}-hide" onclick={() => act('hide')}>Hide</button>
          {#if !narrow}
            <hr />
            <button role="menuitem" onclick={() => act('left')}>Move left</button>
            <button role="menuitem" onclick={() => act('right')}>Move right</button>
            <button role="menuitem" onclick={() => act('up')}>Move up</button>
            <button role="menuitem" onclick={() => act('down')}>Move down</button>
            {#if open}
              <hr />
              <button role="menuitem" onclick={() => act('wider')}>Wider</button>
              <button role="menuitem" onclick={() => act('narrower')}>Narrower</button>
              <button role="menuitem" onclick={() => act('taller')}>Taller</button>
              <button role="menuitem" onclick={() => act('shorter')}>Shorter</button>
            {/if}
          {/if}
        </div>
      {/if}
    </span>
  </header>
  {#if open || keepMounted}
    <div class="body" class:off={!open}>{@render content(tile.id)}</div>
  {/if}
  {#if open && !narrow}
    <div class="grip" data-testid="tile-{tile.id}-resize" role="presentation" title="Drag to resize" onpointerdown={(e) => ongripdown?.(e, tile.id)}></div>
  {/if}
</div>

<style>
  .tile { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; box-sizing: border-box;
    background: var(--color-panel); border: 1px solid var(--color-line); border-radius: 12px; }
  .tile.hidden { display: none; }
  .tile.dragging { opacity: 0; }
  .tile.raised { z-index: 20; }
  header { display: flex; align-items: center; gap: 4px; height: 30px; flex: none; padding: 0 4px 0 10px; }
  .handle { flex: 1; min-width: 0; text-align: left; background: transparent; border: none; padding: 0; height: 100%;
    font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--color-haze); cursor: grab; touch-action: none;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .handle:disabled { cursor: default; }
  .handle:hover:not(:disabled) { color: var(--color-text); }
  @media (prefers-reduced-motion: reduce) { .tile, .tile * { transition: none !important; animation: none !important; } }
  .icon { width: 22px; height: 22px; line-height: 1; padding: 0; border: 1px solid transparent; background: transparent;
    color: var(--color-haze); border-radius: 6px; cursor: pointer; font-size: 14px; }
  .icon:hover { color: var(--color-text); border-color: var(--color-line2); }
  .menuwrap { position: relative; }
  .menu { position: absolute; right: 0; top: 26px; z-index: 30; min-width: 140px; padding: 4px; background: var(--color-panel2);
    border: 1px solid var(--color-line2); border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,.5); display: flex; flex-direction: column; }
  .menu button { text-align: left; background: transparent; border: none; color: var(--color-text); font-size: 12px; padding: 5px 8px; border-radius: 5px; cursor: pointer; }
  .menu button:hover { background: rgba(124,108,255,.16); }
  .menu hr { border: none; border-top: 1px solid var(--color-line); margin: 3px 0; }
  .body { flex: 1; min-height: 0; overflow: auto; padding: 0 12px 12px; }
  .body.off { display: none; }
  .grip { position: absolute; right: 0; bottom: 0; width: 18px; height: 18px; cursor: nwse-resize; touch-action: none;
    background: linear-gradient(135deg, transparent 55%, var(--color-line2) 55%, var(--color-line2) 63%, transparent 63%, transparent 75%, var(--color-line2) 75%, var(--color-line2) 83%, transparent 83%);
    border-bottom-right-radius: 12px; }
</style>
