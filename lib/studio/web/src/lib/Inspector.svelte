<script>
  import { studio, selectedNode } from './store.svelte.js';
  let { onadd } = $props();

  const node = $derived(selectedNode());
  const sel = (n) => (n.id ? `{ id: ${n.id} }` : n.text ? `{ text: ${JSON.stringify(n.text)} }` : `{ subtype: ${n.subtype} }`);

  const asserts = $derived.by(() => {
    if (!node) return [];
    const s = sel(node);
    const a = [`- assertVisible: ${s}`];
    if (node.text) a.push(`- assertText: { ${s.slice(2, -2)}, equals: ${JSON.stringify(node.text)} }`);
    if (node.focused) a.push(`- assertFocused: ${s}`);
    return a;
  });

  const fields = $derived.by(() => {
    if (!node) return [];
    return Object.entries(node.attrs || {}).filter(([k]) => !['name', 'text'].includes(k));
  });
</script>

{#if !node}
  <p class="empty">Click a box on the monitor to inspect a node, then add assertions into the flow.</p>
{:else}
  <div class="head">
    <span class="subtype">{node.subtype}</span>
    {#if node.id}<span class="id">#{node.id}</span>{/if}
    {#if node.focused}<span class="tag">focused</span>{/if}
  </div>
  {#if node.text}<div class="text">“{node.text}”</div>{/if}

  <dl class="fields">
    <div><dt>children</dt><dd>{node.childCount}</dd></div>
    {#if node.abs}<div><dt>bounds</dt><dd>{node.abs.x}, {node.abs.y}, {node.abs.w}, {node.abs.h}</dd></div>{/if}
    {#each fields as [k, v]}
      <div><dt>{k}</dt><dd>{v}</dd></div>
    {/each}
  </dl>

  <div class="add">
    <div class="eyebrow">add to flow</div>
    {#each asserts as a}
      <button onclick={() => onadd?.(a)}>{a}</button>
    {/each}
  </div>
{/if}

<style>
  .empty { color: var(--color-haze); font-size: 13px; margin: 0; }
  .head { display: flex; align-items: baseline; gap: 8px; }
  .subtype { color: var(--color-text); font-weight: 600; }
  .id { font-family: var(--font-mono); color: var(--color-violet); font-size: 13px; }
  .tag { margin-left: auto; font-size: 11px; color: var(--color-amber); border: 1px solid rgba(255,194,75,.4); border-radius: 999px; padding: 1px 8px; }
  .text { color: var(--color-haze); margin-top: 4px; }

  .fields { margin: 12px 0 0; display: grid; gap: 2px; }
  .fields > div { display: grid; grid-template-columns: 96px 1fr; gap: 10px; padding: 3px 0; border-top: 1px solid var(--color-line); }
  dt { color: var(--color-haze); font-size: 12px; font-family: var(--font-mono); }
  dd { margin: 0; color: var(--color-text); font-size: 12px; font-family: var(--font-mono); word-break: break-word; }

  .add { margin-top: 14px; }
  .eyebrow { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--color-haze); margin-bottom: 6px; }
  .add button {
    display: block; width: 100%; text-align: left; margin: 4px 0; padding: 7px 10px;
    background: #10131c; border: 1px solid var(--color-line); border-radius: 8px; cursor: pointer;
    color: #b7c0ff; font-family: var(--font-mono); font-size: 12px; transition: border-color .12s, background .12s;
  }
  .add button:hover { border-color: var(--color-violet); background: #141a2b; }
</style>
