<script>
  import { studio, selectedNode } from './store.svelte.js';
  import { matchesSel, parseSel } from './match.js';

  let { onadd } = $props();
  const node = $derived(selectedNode());
  let test = $state('');

  const count = (sel) => studio.nodes.filter((n) => matchesSel(n, sel)).length;

  const candidates = $derived.by(() => {
    if (!node) return [];
    const list = [];
    if (node.id) list.push({ sel: { id: node.id }, text: `{ id: ${node.id} }` });
    if (node.text) list.push({ sel: { text: node.text }, text: `{ text: ${JSON.stringify(node.text)} }` });
    list.push({ sel: { subtype: node.subtype }, text: `{ subtype: ${node.subtype} }` });
    return list.map((c) => ({ ...c, n: count(c.sel) }));
  });

  const testSel = $derived(test.trim() ? parseSel(test) : null);
  const testCount = $derived(testSel ? count(testSel) : null);

  // Highlight the hovered candidate / typed selector on the monitor; clear on unmount.
  const setProbe = (sel) => (studio.probe = sel);
  $effect(() => { studio.probe = testSel; });
  $effect(() => () => { studio.probe = null; });

  function copy(t) { navigator.clipboard?.writeText(t).catch(() => {}); }
</script>

{#if !node}
  <p class="empty">Select a node to see stable-selector candidates, or type a selector below to test it against the live tree.</p>
{:else}
  <div class="eyebrow">candidates for {node.subtype}{node.id ? ' #' + node.id : ''}</div>
  <ul class="cands">
    {#each candidates as c}
      <li onmouseenter={() => setProbe(c.sel)} onmouseleave={() => setProbe(testSel)}>
        <code>{c.text}</code>
        <span class="badge" class:uniq={c.n === 1} class:amb={c.n !== 1}>{c.n === 1 ? 'unique' : c.n + ' matches'}</span>
        <button class="mini" title="copy" onclick={() => copy(c.text)}>copy</button>
        <button class="mini add" title="add assertVisible" onclick={() => onadd?.(`- assertVisible: ${c.text}`)}>+ assert</button>
      </li>
    {/each}
  </ul>
{/if}

<div class="test">
  <div class="eyebrow">test a selector</div>
  <input placeholder="id: playButton   ·   subtype: Button   ·   textContains: Play" bind:value={test} />
  {#if testSel}
    <div class="result">
      <span class="badge" class:uniq={testCount === 1} class:amb={testCount !== 1}>{testCount} match{testCount === 1 ? '' : 'es'}</span>
      <span class="hint">highlighted on the monitor</span>
    </div>
  {/if}
</div>

<style>
  .empty { color: var(--color-haze); font-size: 13px; margin: 0 0 14px; }
  .eyebrow { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--color-haze); margin-bottom: 8px; }
  .cands { list-style: none; margin: 0 0 16px; padding: 0; display: grid; gap: 6px; }
  .cands li { display: flex; align-items: center; gap: 8px; }
  code { flex: 1; font-family: var(--font-mono); font-size: 12px; color: #b7c0ff; background: #10131c; border: 1px solid var(--color-line); border-radius: 7px; padding: 6px 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { font-size: 10.5px; font-family: var(--font-mono); border-radius: 999px; padding: 2px 9px; white-space: nowrap; }
  .badge.uniq { color: var(--color-pass); border: 1px solid rgba(69,212,131,.4); }
  .badge.amb { color: var(--color-amber); border: 1px solid rgba(255,194,75,.4); }
  .mini { background: var(--color-panel2); color: var(--color-text); border: 1px solid var(--color-line2); border-radius: 7px; padding: 5px 9px; cursor: pointer; font-size: 11px; }
  .mini:hover { border-color: var(--color-violet); }
  .mini.add { color: #b7c0ff; }

  .test { border-top: 1px solid var(--color-line); padding-top: 14px; }
  .test input { width: 100%; box-sizing: border-box; background: #10131c; color: var(--color-text); border: 1px solid var(--color-line2); border-radius: 8px; padding: 8px 10px; font-family: var(--font-mono); font-size: 12px; }
  .test input:focus { outline: none; border-color: var(--color-violet); }
  .result { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
  .hint { color: var(--color-haze); font-size: 12px; }
</style>
