<script>
  import { studio } from './store.svelte.js';
  import { rowsOf } from './rows.js';

  // `data` defaults to the live snapshot but can be passed a trace step's captured appState (time machine).
  let { data = null, onadd = null } = $props();
  const snap = $derived(data ?? studio.appState);

  const rows = $derived(snap && snap.present && snap.state ? rowsOf(snap.state) : []);

  // Agent layers (__bt_agent), read-only. Live view only: a trace step captures just the __bt_state snapshot.
  const agent = $derived(data ? null : studio.agent);
  const layerNames = $derived(agent && agent.present && !agent.error ? Object.keys(agent.layers || {}) : []);
  const layerRows = (name) => rowsOf(agent.layers[name].state);

  const fmt = (v, t) => (t === 'string' ? `"${v}"` : String(v));
  const yamlVal = (v, t) => (t === 'string' ? JSON.stringify(v) : String(v));
</script>

{#if agent && agent.present && agent.error}
  <p class="empty err">Agent state is unreadable: {agent.error}</p>
{:else if layerNames.length}
  {#each layerNames as name}
    <h4 class="layer">{name}
      {#if agent.layers[name].truncated.length}
        <span class="trunc" title={agent.layers[name].truncated.join(', ')}>truncated ({agent.layers[name].truncated.length})</span>
      {/if}
    </h4>
    <dl class="rows">
      {#each layerRows(name) as r}
        <div class="row" style="padding-left: {r.depth * 14}px">
          <dt>{r.key}</dt>
          {#if r.branch}
            <dd class="badge">{r.badge}</dd>
          {:else}
            <dd class="val {r.type}">{fmt(r.value, r.type)}</dd>
            {#if onadd}
              <button class="add" title="add assertState to flow"
                onclick={() => onadd(`- assertState: { layer: ${name}, path: ${r.path}, equals: ${yamlVal(r.value, r.type)} }`)}>+</button>
            {/if}
          {/if}
        </div>
      {/each}
    </dl>
  {/each}
{:else if !snap || !snap.present}
  <p class="empty">
    No app state published. Mirror it into a hidden <code>__bt_state</code> node
    (see <code>BTState_publish</code> in the streaming sample) and it shows up here.
  </p>
{:else if snap.error}
  <p class="empty err">Published state is unreadable: {snap.error}</p>
{:else}
  <dl class="rows">
    {#each rows as r}
      <div class="row" style="padding-left: {r.depth * 14}px">
        <dt>{r.key}</dt>
        {#if r.branch}
          <dd class="badge">{r.badge}</dd>
        {:else}
          <dd class="val {r.type}">{fmt(r.value, r.type)}</dd>
          {#if onadd}
            <button class="add" title="add assertState to flow"
              onclick={() => onadd(`- assertState: { path: ${r.path}, equals: ${yamlVal(r.value, r.type)} }`)}>+</button>
          {/if}
        {/if}
      </div>
    {/each}
  </dl>
{/if}

<style>
  .empty { color: var(--color-haze); font-size: 13px; margin: 0; line-height: 1.5; }
  .empty code { font-family: var(--font-mono); color: var(--color-violet); font-size: 12px; }
  .empty.err { color: var(--color-amber); }

  .rows { margin: 0; display: grid; gap: 1px; }
  .row { display: grid; grid-template-columns: 1fr auto auto; align-items: baseline; gap: 10px; padding: 3px 0; border-top: 1px solid var(--color-line); }
  dt { color: var(--color-haze); font-size: 12px; font-family: var(--font-mono); }
  dd { margin: 0; font-size: 12px; font-family: var(--font-mono); word-break: break-word; text-align: right; }
  .layer { margin: 10px 0 4px; font-size: 12px; font-family: var(--font-mono); color: var(--color-violet); }
  .trunc { color: var(--color-amber); margin-left: 6px; font-weight: normal; }
  .badge { color: var(--color-haze); opacity: .7; }
  .val.string { color: #9ece6a; }
  .val.number { color: #ff9e64; }
  .val.boolean { color: var(--color-violet); }
  .val.null { color: var(--color-haze); }

  .add {
    background: #10131c; border: 1px solid var(--color-line); border-radius: 6px; cursor: pointer;
    color: #b7c0ff; font-family: var(--font-mono); font-size: 12px; line-height: 1; padding: 2px 7px;
    opacity: 0; transition: opacity .12s, border-color .12s;
  }
  .row:hover .add { opacity: 1; }
  .add:hover { border-color: var(--color-violet); }
</style>
