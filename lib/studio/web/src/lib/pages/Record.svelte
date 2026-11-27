<script>
  import Stage from '../Stage.svelte';
  import Remote from '../Remote.svelte';
  import TileGrid from '../TileGrid.svelte';
  import { onDestroy } from 'svelte';
  import { load, save, setState, defaultLayout } from '../layout.js';
  import { recordRegistry, RECORD_KEY } from '../tiles.js';
  let { shotSrc, source = null, treeAt = 0, settling = false, aid = false, active, recText, stepCount, msg, onstart, onstop, onclear, onsave, onpress, oncontext } = $props();
  let pre;
  // Own layout, own storage key (bt.studio.layout.record); saved 300 ms after the last committed change.
  const store = typeof localStorage === 'undefined' ? null : localStorage;
  let layout = $state(load(store, RECORD_KEY, recordRegistry));
  let timer = null;
  function commit(next) {
    layout = next;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; if (store) save(store, RECORD_KEY, layout, recordRegistry); }, 300);
  }
  onDestroy(() => { if (timer) { clearTimeout(timer); if (store) save(store, RECORD_KEY, layout, recordRegistry); } }); // flush a pending save when leaving the page
  $effect(() => { recText; if (pre) pre.scrollTop = pre.scrollHeight; });
</script>

<div class="work" data-testid="page-record">
  <div class="bar">
    {#each Object.keys(recordRegistry.tiles) as id}
      {@const t = layout.find((o) => o.id === id)}
      <label><input type="checkbox" data-testid="record-tile-toggle-{id}" checked={t && t.state !== 'hidden'} onchange={(e) => commit(setState(layout, id, e.currentTarget.checked ? 'open' : 'hidden', recordRegistry))} /> {recordRegistry.tiles[id].title}</label>
    {/each}
    <button class="ghost" data-testid="record-layout-reset" onclick={() => commit(defaultLayout(recordRegistry))}>Reset layout</button>
  </div>
  <TileGrid {layout} registry={recordRegistry} oncommit={commit} label="Record layout" gridTestid="record-layout-grid" liveTestid="record-layout-live">
    {#snippet content(id)}
      {#if id === 'rec-monitor'}
        <div class="feed">
          <div class="eyebrow"><span class="tip">right-click a node to record an assertion</span></div>
          <div class="stagebox"><Stage {shotSrc} {source} {treeAt} {settling} {aid} fit="contain" {oncontext} /></div>
        </div>
      {:else if id === 'rec-remote'}
        <div class="remotecard">
          <div class="eyebrow">{#if active}<span class="rec">● REC</span>{/if}</div>
          <div class="remotewrap"><Remote onact={onpress} /></div>
        </div>
      {:else if id === 'rec-steps'}
        <div class="recpanel">
          <div class="rhead">
            <div class="ctl">
              {#if !active}
                <button class="primary" data-testid="record-start" aria-label="Start recording" onclick={onstart}>● Record</button>
              {:else}
                <button class="stop" data-testid="record-stop" aria-label="Stop recording" onclick={onstop}>■ Stop</button>
              {/if}
              <button class="ghost" data-testid="record-clear" aria-label="Clear recording" onclick={onclear} disabled={!stepCount}>Clear</button>
              <button class="ghost" data-testid="record-save" aria-label="Save recording" onclick={onsave} disabled={!stepCount}>Save…</button>
              <span class="msg" data-testid="record-message" role="status">{msg}</span>
            </div>
          </div>
          <pre bind:this={pre} class="doc" data-testid="record-doc" aria-label="Recorded steps">{recText || '# Press ● Record, then drive the remote.\n# Each press is captured live below.'}</pre>
          <p class="hint">Every remote press is captured live; repeats coalesce into a count. Right-click a node on the monitor to record an assertion built from its real values.</p>
        </div>
      {/if}
    {/snippet}
  </TileGrid>
</div>

<style>
  .work { display: flex; flex-direction: column; gap: 10px; padding: 18px; box-sizing: border-box; overflow: auto; height: 100%; }
  .bar { display: flex; align-items: center; gap: 14px; font-size: 12px; color: var(--color-haze); }
  .bar label { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
  .feed { display: flex; flex-direction: column; gap: 8px; height: 100%; min-height: 0; }
  .stagebox { flex: 1; min-height: 0; }
  .remotecard { display: flex; flex-direction: column; gap: 6px; height: 100%; overflow: auto; }
  .remotewrap { display: flex; justify-content: center; }
  .recpanel { height: 100%; display: grid; grid-template-rows: auto 1fr auto; min-height: 0; }

  .eyebrow { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--color-haze); }
  .tip { text-transform: none; letter-spacing: 0; color: #4c5266; margin-left: 8px; font-size: 10.5px; }
  .rec { color: var(--color-fail); margin-left: 8px; letter-spacing: .12em; animation: blink 1.1s steps(2,end) infinite; }
  @keyframes blink { 50% { opacity: .35; } }

  .rhead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .ctl { display: flex; align-items: center; gap: 8px; }
  .primary { background: var(--color-fail); color: #0c0e14; font-weight: 700; border: none; border-radius: 8px; padding: 6px 14px; cursor: pointer; }
  .primary:hover { filter: brightness(1.08); }
  .stop { background: var(--color-panel2); color: var(--color-text); border: 1px solid var(--color-fail); border-radius: 8px; padding: 6px 14px; cursor: pointer; }
  .ghost { background: var(--color-panel2); color: var(--color-text); border: 1px solid var(--color-line2); border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 12px; }
  .ghost:hover:not(:disabled) { border-color: var(--color-violet); }
  .ghost:disabled { opacity: .45; cursor: default; }
  .msg { font-family: var(--font-mono); font-size: 12px; color: var(--color-pass); }

  .doc {
    margin: 0; min-height: 0; overflow: auto; background: #0d1016; border: 1px solid var(--color-line);
    border-radius: 10px; padding: 12px 14px; font-family: var(--font-mono); font-size: 12.5px; line-height: 1.7;
    color: #dfe4ee; white-space: pre; tab-size: 2;
  }
  .doc:empty::before { content: ''; }
  .hint { color: var(--color-haze); font-size: 12px; margin: 10px 0 0; }
</style>
