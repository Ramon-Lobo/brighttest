<script module>
  const persisters = new WeakMap();
  const noStorage = { getItem: () => null, setItem() {} };
  function sharedPersister(storage) {
    const st = storage || noStorage;
    if (!persisters.has(st)) persisters.set(st, createPersister(st));
    return persisters.get(st);
  }
</script>

<script>
  // Shared state tree: key column, indentation, disclosure toggle, count badge, match marks and chunk rows.
  // Callers render the value cell and trailing actions through snippets, so editing and chips stay theirs.
  import { tick, onDestroy, untrack } from 'svelte';
  import {
    treeRows, restoreModel, createPersister, visible, toggle, setCollapsed, isCollapsed, collapseAll, expandAll,
    showMore, reveal, match, highlight,
  } from './statetree.js';

  // value: the object to show (rows is derived), or rows: precomputed treeRows output.
  // search: optional { query, caseSensitive, mode: 'highlight'|'filter', current: <path> } shared by several trees.
  // onmatches(paths): reports this tree's matches so one bar can walk several layers.
  // editing: path of a row being edited; it always passes a filter.
  let { value = undefined, rows: rowsProp = undefined, classify = undefined, storageKey, surface = 'state',
        cell, actions, search = null, onmatches = undefined, editing = null, storage = globalThis.localStorage } = $props();

  const rows = $derived(rowsProp || treeRows(value, classify ? { classify } : {}));
  const byPath = $derived(new Map(rows.map((r) => [r.path, r])));

  // One persister per storage, shared by every tree: separate copies would each write back only their own keys.
  // svelte-ignore state_referenced_locally
  const persister = sharedPersister(storage);
  let version = $state(0); // bumped when the (non-reactive) model or chunk map changes
  let model = $state.raw(restoreModel({ keys: {} }, ''));
  let more = $state.raw({});
  let loadedKey = null;
  let focusPath = $state(null);
  let el;

  $effect(() => {
    if (loadedKey !== storageKey) { loadedKey = storageKey; model = persister.get(storageKey); more = {}; version++; }
  });

  const found = $derived(search && search.query ? match(rows, search.query, { caseSensitive: !!search.caseSensitive, mode: search.mode }) : null);
  $effect(() => { onmatches?.(found ? found.matches : []); });

  // keep: matches plus ancestors, plus the row being edited and its ancestors
  const keep = $derived.by(() => {
    if (!found || !found.keep) return null;
    const k = new Set(found.keep);
    if (editing != null) {
      for (let r = byPath.get(editing); r; r = byPath.get(r.parent)) k.add(r.path);
    }
    return k;
  });

  const matchSet = $derived(new Set(found ? found.matches : []));
  const shown = $derived.by(() => { version; return visible(rows, model, { more, keep }); });
  const items = $derived(shown.filter((r) => !r.more));

  function persist() { version++; persister.save(storageKey, model, rows); }
  const flip = (row) => { toggle(model, row); persist(); };
  const moreOf = (row) => { more = showMore(more, row.parent); version++; };

  // Jump to a match: expand its ancestors (remembered), render its chunk, scroll to it.
  export async function goto(path) {
    more = reveal(rows, model, more, path);
    persist();
    focusPath = path;
    await tick();
    el?.querySelector(`[data-path="${CSS.escape(path)}"]`)?.scrollIntoView?.({ block: 'center' });
  }
  export function collapseEvery() { collapseAll(rows, model); persist(); }
  export function expandEvery() { expandAll(rows, model); persist(); }

  // Jump to the match the caller names (next/prev, or the first match of a new query).
  // untracked: goto reads and writes the model, which must not re-trigger this effect. It jumps once per target and
  // query: a 2 s refresh keeps the current match by path but must not undo a collapse the user made since.
  let jumped = '';
  $effect(() => {
    const at = search && search.current;
    const tag = at ? `${search.query}\u0000${search.caseSensitive}\u0000${at}` : '';
    if (!at) jumped = '';
    else if (byPath.has(at) && tag !== jumped) { jumped = tag; untrack(() => goto(at)); }
  });

  const tabPath = $derived(items.some((r) => r.path === focusPath) ? focusPath : items[0]?.path);
  const posOf = (row) => Math.min(row.idx + 1, 1e9);
  const sizeOf = (row) => (row.parent === '' ? rows.rootCount : byPath.get(row.parent)?.count);

  function focusRow(path) {
    focusPath = path;
    tick().then(() => el?.querySelector(`[data-path="${CSS.escape(path)}"]`)?.focus());
  }

  function onkey(e, row) {
    if (e.target !== e.currentTarget) return; // inputs inside a row keep their own keys
    const i = items.indexOf(row);
    const go = (r) => { if (r) { e.preventDefault(); focusRow(r.path); } };
    if (e.key === 'ArrowDown') go(items[i + 1]);
    else if (e.key === 'ArrowUp') go(items[i - 1]);
    else if (e.key === 'Home') go(items[0]);
    else if (e.key === 'End') go(items[items.length - 1]);
    else if (e.key === 'ArrowRight' && row.branch) {
      e.preventDefault();
      if (isCollapsed(row, model)) flip(row); else go(items[i + 1]?.parent === row.path ? items[i + 1] : null);
    } else if (e.key === 'ArrowLeft') {
      if (row.branch && !isCollapsed(row, model)) { e.preventDefault(); flip(row); }
      else go(items.find((r) => r.path === row.parent));
    } else if (e.key === '*') {
      e.preventDefault();
      for (const r of rows) if (r.branch && r.parent === row.parent) setCollapsed(model, r, false);
      persist();
    }
  }

  onDestroy(() => persister.flush());
</script>

<div class="tree" role="tree" data-testid="state-tree" data-surface={surface} data-key={storageKey} bind:this={el}>
  {#each shown as row (row.path)}
    {#if row.more}
      <div class="row more" role="none" style="padding-left:{row.depth * 14 + 8}px">
        <button type="button" data-testid="state-row-more" onclick={() => moreOf({ parent: row.parent })}>
          show {Math.min(100, row.remaining)} more ({row.remaining} left)
        </button>
      </div>
    {:else}
      <div class="row" class:match={matchSet.has(row.path)} class:current={!!search && search.current === row.path} role="treeitem"
        data-testid="state-row" data-path={row.path} aria-level={row.depth + 1}
        aria-expanded={row.branch ? !isCollapsed(row, model) : undefined}
        aria-setsize={sizeOf(row)} aria-posinset={posOf(row)} aria-selected={focusPath === row.path}
        tabindex={row.path === tabPath ? 0 : -1} style="padding-left:{row.depth * 14 + 8}px"
        onfocus={() => (focusPath = row.path)} onkeydown={(e) => onkey(e, row)}>
        {#if row.branch}
          <button type="button" class="tog" data-testid="state-row-toggle" tabindex="-1"
            aria-expanded={!isCollapsed(row, model)} aria-label={isCollapsed(row, model) ? 'expand' : 'collapse'}
            onclick={() => flip(row)}>{isCollapsed(row, model) ? '▸' : '▾'}</button>
        {:else}<span class="tog"></span>{/if}
        <span class="key">{#each highlight(row.key, search?.query, !!search?.caseSensitive) as s}{#if s.mark}<mark>{s.text}</mark>{:else}{s.text}{/if}{/each}</span>
        {#if row.branch}
          <span class="badge">{row.badge}</span>
        {:else if cell}
          <span class="val">{@render cell(row, search)}</span>
        {/if}
        {#if actions}<span class="act">{@render actions(row)}</span>{/if}
      </div>
    {/if}
  {/each}
</div>

<style>
  .row { display: flex; align-items: center; gap: 6px; padding-top: 2px; padding-bottom: 2px; font-size: 12px; }
  .row:focus-visible { outline: 1px solid var(--accent, #4a9eff); outline-offset: -1px; }
  .row.match { background: rgba(255, 210, 0, 0.12); }
  .row.current { background: rgba(255, 210, 0, 0.28); outline: 1px solid rgba(255, 210, 0, 0.6); outline-offset: -1px; }
  .row:hover :global(.add), .row:focus-within :global(.add) { opacity: 1; }
  .act { display: inline-flex; gap: 6px; align-items: center; }
  .tog { width: 14px; flex: none; background: none; border: 0; padding: 0; color: inherit; cursor: pointer; }
  .key { font-family: ui-monospace, monospace; }
  .badge { opacity: 0.6; font-size: 11px; }
  .val { flex: 1; min-width: 0; text-align: right; word-break: break-word; font-family: ui-monospace, monospace; }
  mark { background: rgba(255, 210, 0, 0.45); color: inherit; border-radius: 2px; }
</style>
