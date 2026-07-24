<script>
  import { studio } from './store.svelte.js';

  let q = $state('');
  let collapsed = $state({}); // path -> true when collapsed

  // Rebuild the nested tree from the flat, DFS-ordered node list using each node's depth.
  const roots = $derived.by(() => {
    const stack = [], out = [];
    for (const n of studio.nodes) {
      const node = { ...n, children: [] };
      if (n.depth === 0 || !stack[n.depth - 1]) out.push(node);
      else stack[n.depth - 1].children.push(node);
      stack[n.depth] = node; stack.length = n.depth + 1;
    }
    return out;
  });

  const hit = (n) => {
    const s = `${n.subtype} ${n.id || ''} ${n.text || ''}`.toLowerCase();
    return s.includes(q.trim().toLowerCase());
  };
  const matches = $derived.by(() => (q.trim() ? studio.nodes.filter(hit) : null));

  const pick = (n) => (studio.selectedPath = n.path);
  const hover = (n) => (studio.hoverPath = n.path);
  const unhover = (n) => { if (studio.hoverPath === n.path) studio.hoverPath = null; };
</script>

<div class="tree">
  <input class="search" placeholder="filter by id / text / subtype…" bind:value={q} />
  <div class="scroll">
    {#if matches}
      {#if !matches.length}<p class="empty">no matches</p>{/if}
      {#each matches as n}
        <button class="row" class:sel={n.path === studio.selectedPath} style="padding-left:8px"
          onclick={() => pick(n)} onmouseenter={() => hover(n)} onmouseleave={() => unhover(n)}>
          {@render label(n)}
        </button>
      {/each}
    {:else}
      {#each roots as n}{@render branch(n, 0)}{/each}
    {/if}
  </div>
</div>

{#snippet label(n)}
  <span class="sub">{n.subtype}</span>
  {#if n.id}<span class="id">#{n.id}</span>{/if}
  {#if n.text}<span class="txt">“{n.text}”</span>{/if}
  {#if n.focused}<span class="foc" title="focused"></span>{/if}
{/snippet}

{#snippet branch(n, depth)}
  <div class="node">
    <div class="line" class:sel={n.path === studio.selectedPath} class:hov={n.path === studio.hoverPath} style="padding-left:{6 + depth * 13}px">
      {#if n.children.length}
        <button class="caret" class:closed={collapsed[n.path]} aria-label="toggle"
          onclick={() => (collapsed[n.path] = !collapsed[n.path])}>▸</button>
      {:else}<span class="caret ph"></span>{/if}
      <button class="rowbtn" onclick={() => pick(n)} onmouseenter={() => hover(n)} onmouseleave={() => unhover(n)}>
        {@render label(n)}
      </button>
    </div>
    {#if n.children.length && !collapsed[n.path]}
      {#each n.children as c}{@render branch(c, depth + 1)}{/each}
    {/if}
  </div>
{/snippet}

<style>
  .tree { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 8px; }
  .search { background: #10131c; color: var(--color-text); border: 1px solid var(--color-line2); border-radius: 8px; padding: 6px 10px; font-size: 12px; font-family: var(--font-mono); }
  .search:focus { outline: none; border-color: var(--color-violet); }
  .scroll { overflow: auto; min-height: 0; flex: 1; margin: 0 -6px; }
  .empty { color: var(--color-haze); font-size: 12px; padding: 6px 10px; }
  /* flat filtered list uses a plain button row */
  .row {
    display: flex; align-items: center; gap: 6px; width: 100%; text-align: left; background: transparent;
    border: none; cursor: pointer; color: var(--color-haze); font-family: var(--font-mono); font-size: 12px;
    padding: 3px 8px; border-radius: 6px; white-space: nowrap;
  }
  .row:hover { background: #171b28; color: var(--color-text); }
  .row.sel { background: rgba(124,108,255,.16); color: #cfc9ff; }

  /* tree row = caret button + label button, siblings (no nested interactives) */
  .line { display: flex; align-items: center; gap: 4px; border-radius: 6px; }
  .line:hover, .line.hov { background: #171b28; }
  .line.sel { background: rgba(124,108,255,.16); }
  .rowbtn {
    display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; text-align: left; background: transparent;
    border: none; cursor: pointer; color: var(--color-haze); font-family: var(--font-mono); font-size: 12px;
    padding: 3px 6px 3px 0; white-space: nowrap;
  }
  .line:hover .rowbtn, .line.sel .rowbtn { color: var(--color-text); }
  .line.sel .rowbtn { color: #cfc9ff; }
  .caret { background: transparent; border: none; cursor: pointer; color: #5b6178; width: 14px; padding: 0; transition: transform .1s; }
  .caret.closed { transform: rotate(-90deg); }
  .caret.ph { visibility: hidden; cursor: default; }
  .sub { color: var(--color-text); }
  .id { color: var(--color-violet); }
  .txt { color: var(--color-haze); overflow: hidden; text-overflow: ellipsis; }
  .foc { width: 6px; height: 6px; border-radius: 50%; background: var(--color-amber); box-shadow: 0 0 6px var(--color-amber); margin-left: 2px; }
</style>
