<script>
  // The search bar above one or more state trees: query (debounced 120 ms), previous/next across layers with a
  // "3 of 17" count, case and filter toggles, collapse all / expand all. `s` comes from createStateSearch().
  import { onDestroy } from 'svelte';

  let { s, oncollapse = undefined, onexpand = undefined } = $props();
  let text = $state('');
  let timer = null;
  function type(v) {
    text = v;
    clearTimeout(timer);
    timer = setTimeout(() => { s.query = text; }, 120);
  }
  function key(e) {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); if (s.query !== text) s.query = text; else s.step(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape' && text) { e.preventDefault(); type(''); }
  }
  onDestroy(() => clearTimeout(timer));
  const count = $derived(!s.query ? '' : s.total ? `${s.index + 1} of ${s.total}` : 'no matches');
</script>

<div class="bar" role="search">
  <input class="f" type="search" data-testid="state-search" aria-label="Search state" placeholder="search keys and values"
    value={text} oninput={(e) => type(e.currentTarget.value)} onkeydown={key} />
  <button type="button" data-testid="state-search-prev" title="previous match" aria-label="previous match" disabled={!s.total} onclick={() => s.step(-1)}>↑</button>
  <button type="button" data-testid="state-search-next" title="next match" aria-label="next match" disabled={!s.total} onclick={() => s.step(1)}>↓</button>
  <span class="cnt" data-testid="state-search-count" aria-live="polite">{count}</span>
  <button type="button" class:on={s.caseSensitive} data-testid="state-search-case" title="match case" aria-pressed={s.caseSensitive} onclick={() => (s.caseSensitive = !s.caseSensitive)}>Aa</button>
  <button type="button" class:on={s.filter} data-testid="state-search-filter" title="show only matching rows" aria-pressed={s.filter} onclick={() => (s.filter = !s.filter)}>filter</button>
  <button type="button" data-testid="state-collapse-all" title="collapse all" onclick={() => oncollapse?.()}>collapse all</button>
  <button type="button" data-testid="state-expand-all" title="expand all" onclick={() => onexpand?.()}>expand all</button>
</div>

<style>
  /* sticky: the panel scrolls to the current match, the bar must stay in reach */
  .bar { display: flex; gap: 6px; align-items: center; margin: 0 0 6px; padding: 6px 0; flex-wrap: wrap; position: sticky; top: 0; z-index: 2; background: var(--color-panel); }
  .f { flex: 1; min-width: 120px; background: #10131c; border: 1px solid var(--color-line); border-radius: 6px; color: inherit; font-family: var(--font-mono); font-size: 12px; padding: 3px 7px; }
  button { background: #10131c; border: 1px solid var(--color-line); border-radius: 6px; cursor: pointer; color: #b7c0ff; font-family: var(--font-mono); font-size: 12px; padding: 3px 8px; }
  button:hover:not(:disabled) { border-color: var(--color-violet); }
  button:disabled { opacity: .5; cursor: default; }
  button.on { border-color: var(--color-violet); color: #fff; }
  .cnt { color: var(--color-haze); font-size: 11px; font-family: var(--font-mono); min-width: 52px; }
</style>
