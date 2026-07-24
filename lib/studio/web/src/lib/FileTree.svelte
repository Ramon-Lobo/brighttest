<script>
  let { flows = [], current = null, onopen, onnew, ontoggle } = $props();

  // Build a nested tree from the flows' relative paths (folders + files).
  const tree = $derived.by(() => {
    const root = {};
    for (const f of [...flows].sort((a, b) => a.rel.localeCompare(b.rel))) {
      const parts = f.rel.split('/');
      let cur = root;
      parts.forEach((p, i) => {
        cur.children ??= {};
        const leaf = i === parts.length - 1;
        cur.children[p] ??= leaf ? { name: p, rel: f.rel } : { name: p };
        cur = cur.children[p];
      });
    }
    return root.children ? Object.values(root.children) : [];
  });
</script>

<div class="tree">
  <div class="head">
    <span class="eyebrow">flows</span>
    <div class="hbtns">
      <button class="ib" onclick={onnew} title="new flow">+</button>
      {#if ontoggle}<button class="ib" onclick={ontoggle} title="collapse file tree" aria-label="collapse file tree">‹</button>{/if}
    </div>
  </div>
  <div class="list">
    {#if !tree.length}
      <p class="empty">No flows yet</p>
    {:else}
      {#each tree as n}{@render row(n, 0)}{/each}
    {/if}
  </div>
</div>

{#snippet row(n, depth)}
  {#if n.rel}
    <button
      class="file"
      class:active={n.rel === current}
      style="padding-left:{8 + depth * 12}px"
      onclick={() => onopen(n.rel)}
      title={n.rel}
    >
      <span class="dot">›</span>{n.name}
    </button>
  {:else}
    <div class="folder" style="padding-left:{8 + depth * 12}px">{n.name}/</div>
    {#each Object.values(n.children ?? {}) as c}{@render row(c, depth + 1)}{/each}
  {/if}
{/snippet}

<style>
  .tree { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .eyebrow { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--color-haze); }
  .hbtns { display: flex; gap: 4px; }
  .ib { background: var(--color-panel2); color: var(--color-text); border: 1px solid var(--color-line2); border-radius: 7px; width: 24px; height: 24px; cursor: pointer; line-height: 1; }
  .ib:hover { border-color: var(--color-violet); }
  .list { overflow: auto; min-height: 0; flex: 1; margin: 0 -6px; }
  .empty { color: var(--color-haze); font-size: 12px; padding: 8px; }
  .file {
    display: flex; align-items: center; gap: 6px; width: 100%; text-align: left;
    background: transparent; border: none; cursor: pointer; color: var(--color-haze);
    font-family: var(--font-mono); font-size: 12px; padding: 5px 8px; border-radius: 7px;
  }
  .file:hover { background: #171b28; color: var(--color-text); }
  .file.active { background: rgba(124,108,255,.14); color: #cfc9ff; }
  .file .dot { color: var(--color-violet); }
  .folder { font-size: 11px; color: #5b6178; padding: 5px 8px; text-transform: uppercase; letter-spacing: .05em; }
</style>
