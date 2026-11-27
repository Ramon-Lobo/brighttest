<script>
  import { studio } from './store.svelte.js';
  import StateTree from './StateTree.svelte';
  import StateSearch from './StateSearch.svelte';
  import Marked from './Marked.svelte';
  import { createStateSearch } from './statesearch.svelte.js';

  // `data` defaults to the live snapshot but can be passed a trace step's captured appState (time machine).
  let { data = null, onadd = null } = $props();
  const snap = $derived(data ?? studio.appState);
  const search = createStateSearch();
  let trees = $state({});

  // Agent layers (__bt_agent), read-only. Live view only: a trace step captures just the __bt_state snapshot.
  const agent = $derived(data ? null : studio.agent);
  const layerNames = $derived(agent && agent.present && !agent.error ? Object.keys(agent.layers || {}) : []);
  const published = $derived(snap && snap.present && !snap.error && snap.state ? snap.state : null);
  const order = $derived(layerNames.length ? layerNames : published ? ['app'] : []);
  $effect(() => { search.setOrder(order); });
  const sweep = (fn) => order.forEach((n) => trees[n] && trees[n][fn]());

  const fmt = (v, t) => (t === 'string' ? `"${v}"` : String(v));
  const yamlVal = (v, t) => (t === 'string' ? JSON.stringify(v) : String(v));
</script>

{#snippet shown(r, sr)}
  {#if r.kind === 'node'}<span class="val node">→ #{r.id}</span>
  {:else}<span class="val {r.type}">{#if r.type === 'string'}"<Marked text={r.value} search={sr} />"{:else}<Marked text={String(r.value)} search={sr} />{/if}</span>{/if}
{/snippet}

{#if agent && agent.present && agent.error}
  <p class="empty err">Agent state is unreadable: {agent.error}</p>
{:else if layerNames.length}
  <StateSearch s={search} oncollapse={() => sweep('collapseEvery')} onexpand={() => sweep('expandEvery')} />
  {#each layerNames as name}
    {#snippet actions(r)}
      {#if onadd && !r.branch}
        <button class="add" title="add assertState to flow"
          onclick={() => onadd(`- assertState: { layer: ${name}, path: ${r.path}, equals: ${yamlVal(r.value, r.type)} }`)}>+</button>
      {/if}
    {/snippet}
    <h4 class="layer">{name}
      {#if agent.layers[name].truncated.length}
        <span class="trunc" title={agent.layers[name].truncated.join(', ')}>truncated ({agent.layers[name].truncated.length})</span>
      {/if}
    </h4>
    <StateTree bind:this={trees[name]} value={agent.layers[name].state} storageKey={`state:${name}`} surface="state"
      search={search.searchFor(name)} onmatches={(m) => search.report(name, m)} cell={shown} {actions} />
  {/each}
{:else if !snap || !snap.present}
  <p class="empty">
    No app state published. Mirror it into a hidden <code>__bt_state</code> node
    (see <code>BTState_publish</code> in the streaming sample) and it shows up here.
  </p>
{:else if snap.error}
  <p class="empty err">Published state is unreadable: {snap.error}</p>
{:else}
  {#snippet actions(r)}
    {#if onadd && !r.branch}
      <button class="add" title="add assertState to flow"
        onclick={() => onadd(`- assertState: { path: ${r.path}, equals: ${yamlVal(r.value, r.type)} }`)}>+</button>
    {/if}
  {/snippet}
  <StateSearch s={search} oncollapse={() => sweep('collapseEvery')} onexpand={() => sweep('expandEvery')} />
  <StateTree bind:this={trees.app} value={snap.state} storageKey="state:app" surface="state"
    search={search.searchFor('app')} onmatches={(m) => search.report('app', m)} cell={shown} {actions} />
{/if}

<style>
  .empty { color: var(--color-haze); font-size: 13px; margin: 0; line-height: 1.5; }
  .empty code { font-family: var(--font-mono); color: var(--color-violet); font-size: 12px; }
  .empty.err { color: var(--color-amber); }

  .layer { margin: 10px 0 4px; font-size: 12px; font-family: var(--font-mono); color: var(--color-violet); }
  .trunc { color: var(--color-amber); margin-left: 6px; font-weight: normal; }
  .val.node { color: var(--color-violet); }
  .val.string { color: #9ece6a; }
  .val.number { color: #ff9e64; }
  .val.boolean { color: var(--color-violet); }
  .val.null { color: var(--color-haze); }

  .add {
    background: #10131c; border: 1px solid var(--color-line); border-radius: 6px; cursor: pointer;
    color: #b7c0ff; font-family: var(--font-mono); font-size: 12px; line-height: 1; padding: 2px 7px;
    opacity: 0; transition: opacity .12s, border-color .12s;
  }
  .add:hover { border-color: var(--color-violet); }
</style>
