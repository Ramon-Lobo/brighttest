<script>
  import { assertion, focusStep, pressStep, selectorFor } from './steps.js';

  let { node, x, y, onpick, onclose } = $props();

  const items = $derived.by(() => {
    const n = node;
    const fields = Object.keys(n.attrs ?? {});
    return [
      { label: 'Assert', children: [
        { label: 'is visible', line: assertion('visible', n) },
        ...(n.text ? [{ label: 'text equals…', hint: n.text, line: assertion('text', n) }] : []),
        ...(n.focused ? [{ label: 'is focused', line: assertion('focused', n) }] : []),
        { label: 'is gone', line: assertion('gone', n) },
        { label: 'field…', children: fields.map((k) => ({ label: k, hint: String(n.attrs[k]).slice(0, 22), line: assertion('field', n, k) })) },
      ] },
      { label: 'Focus this node', line: focusStep(n) },
      { label: 'Press', children: ['Up', 'Down', 'Left', 'Right', 'Select', 'Back', 'Home'].map((k) => ({ label: k, line: pressStep(k) })) },
      { sep: true },
      { label: 'Copy selector', act: 'copy' },
    ];
  });

  function choose(it) {
    if (it.children) return;
    if (it.act === 'copy') navigator.clipboard?.writeText(selectorFor(node)).catch(() => {});
    else if (it.line) onpick(it.line);
    onclose();
  }

  // Clamp to viewport (menu ~ 220px wide, tall enough for the items).
  const px = $derived(Math.min(x, window.innerWidth - 240));
  const py = $derived(Math.min(y, window.innerHeight - 260));
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />
<div class="backdrop" role="presentation" onpointerdown={onclose} oncontextmenu={(e) => { e.preventDefault(); onclose(); }}></div>

<div class="menu root" style="left:{px}px; top:{py}px">
  <div class="title">{node.subtype}{node.id ? ' #' + node.id : ''}</div>
  {@render level(items)}
</div>

{#snippet level(list)}
  <ul>
    {#each list as it}
      {#if it.sep}
        <li class="sep"></li>
      {:else}
        <li class="item" class:has={it.children}>
          <button onclick={() => choose(it)}>
            <span class="lbl">{it.label}</span>
            {#if it.hint}<span class="hint">{it.hint}</span>{/if}
            {#if it.children}<span class="caret">›</span>{/if}
          </button>
          {#if it.children}
            <div class="menu sub">{@render level(it.children)}</div>
          {/if}
        </li>
      {/if}
    {/each}
  </ul>
{/snippet}

<style>
  .backdrop { position: fixed; inset: 0; z-index: 40; }
  .menu {
    background: var(--color-panel2); border: 1px solid var(--color-line2); border-radius: 10px;
    box-shadow: 0 16px 40px rgba(0,0,0,.55); padding: 5px; min-width: 200px;
  }
  .root { position: fixed; z-index: 41; }
  .title { font-family: var(--font-mono); font-size: 11px; color: var(--color-haze); padding: 4px 10px 6px; border-bottom: 1px solid var(--color-line); margin-bottom: 4px; }
  ul { list-style: none; margin: 0; padding: 0; }
  .item { position: relative; }
  .item > button {
    display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
    background: transparent; border: none; cursor: pointer; color: var(--color-text);
    font-size: 13px; padding: 7px 10px; border-radius: 7px;
  }
  .item > button:hover { background: rgba(124,108,255,.18); }
  .lbl { flex: none; }
  .hint { flex: 1; text-align: right; color: var(--color-haze); font-family: var(--font-mono); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .caret { color: var(--color-haze); margin-left: auto; }
  .sep { height: 1px; background: var(--color-line); margin: 5px 4px; }

  .sub { position: absolute; left: 100%; top: -6px; display: none; }
  .item.has:hover > .sub { display: block; }
</style>
