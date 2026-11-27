<script>
  import { tick } from 'svelte';
  import { api } from './api.js';
  import { bodyText, renderSlice, bodyNotices, findMatches, segments, nextIndex, jsonTokens, hexDump, formatBytes, formPairs } from './netdetail.js';

  // One body (request or response) of a network entry (design 5.3). `view` is the server's body view for that side.
  let { view, side, id, raw = false, contentType = '' } = $props();

  let mode = $state('pretty');   // pretty | raw (Pretty is only used when the body is JSON that parses)
  let showAll = $state(false);
  let query = $state('');
  let caseSens = $state(false);
  let cur = $state(-1);
  let note = $state('');
  let box = $state(null);

  const shown = $derived(bodyText(view, mode));
  const sliced = $derived(renderSlice(shown.text, showAll));
  const starts = $derived(findMatches(sliced.text, query, caseSens));
  const segs = $derived(starts.length ? segments(sliced.text, starts, query.length) : null);
  const tokens = $derived(!segs && shown.pretty ? jsonTokens(sliced.text) : null);
  const notices = $derived(bodyNotices(view));
  const form = $derived(side === 'req' && view && view.text ? formPairs(view.text, contentType) : []);
  const binary = $derived(view && view.kind === 'binary');

  $effect(() => { void query; void caseSens; void mode; cur = starts.length ? 0 : -1; });
  $effect(() => { void cur; void starts; tick().then(() => { const el = box && box.querySelector('mark.cur'); if (el) el.scrollIntoView({ block: 'nearest' }); }); });

  const step = (dir) => { cur = nextIndex(cur, starts.length, dir); };
  function onSearchKey(e) { if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); } }
  async function copy() {
    try { await navigator.clipboard.writeText(binary ? '' : shown.text); note = 'copied'; } catch { note = 'copy failed'; }
  }
  const url = $derived(api.netBodyUrl(id, side, raw));
</script>

<div class="body" data-testid="net-body" data-side={side} data-kind={view ? view.kind : 'none'}>
  {#if !view}
    <p class="muted">No data.</p>
  {:else}
    {#each notices as n}
      <p class="notice" data-testid="net-body-truncated" data-side={side}>{n}</p>
    {/each}
    {#if view.kind === 'empty'}
      <p class="muted">Empty body.</p>
    {:else if view.kind !== 'none'}
      <div class="tools">
        {#if !binary}
          {#if shown.canPretty}
            <button class:on={mode === 'pretty'} data-testid="net-body-pretty" onclick={() => (mode = 'pretty')}>Pretty</button>
            <button class:on={mode === 'raw'} data-testid="net-body-raw" onclick={() => (mode = 'raw')}>Raw</button>
          {/if}
          <input class="s" data-testid="net-body-search" aria-label="search in body" placeholder="search" bind:value={query} onkeydown={onSearchKey} />
          <button data-testid="net-body-search-prev" aria-label="previous match" onclick={() => step(-1)} disabled={!starts.length}>&lsaquo;</button>
          <button data-testid="net-body-search-next" aria-label="next match" onclick={() => step(1)} disabled={!starts.length}>&rsaquo;</button>
          <span class="count" data-testid="net-body-search-count">{query ? (starts.length ? `${cur + 1}/${starts.length}` : '0') : ''}</span>
          <button class:on={caseSens} data-testid="net-body-search-case" aria-label="match case" aria-pressed={caseSens} onclick={() => (caseSens = !caseSens)}>Aa</button>
          <button data-testid="net-body-copy" onclick={copy}>Copy</button>
        {/if}
        <a class="btn" data-testid="net-body-download" href={url} download>Download body</a>
        {#if note}<span class="count">{note}</span>{/if}
      </div>
      {#if form.length}
        <table class="kv"><tbody>{#each form as [k, v]}<tr><td>{k}</td><td>{v}</td></tr>{/each}</tbody></table>
      {/if}
      {#if binary}
        <div data-testid="net-body-binary">
          <p class="muted">Binary body, {formatBytes(view.bytes)}{contentType ? `, ${contentType}` : ''}. First {Math.min(512, view.bytes)} bytes:</p>
          <pre class="txt">{hexDump(view.text)}</pre>
        </div>
      {:else}
        <pre class="txt" bind:this={box}>{#if segs}{#each segs as s}{#if s.hit}<mark class:cur={s.cur}>{s.text}</mark>{:else}{s.text}{/if}{/each}{:else if tokens}{#each tokens as t}<span class={t.cls}>{t.text}</span>{/each}{:else}{sliced.text}{/if}</pre>
        {#if sliced.cut}
          <button data-testid="net-body-show-all" onclick={() => (showAll = true)}>Show all ({formatBytes(shown.text.length)})</button>
        {/if}
      {/if}
    {/if}
  {/if}
</div>

<style>
  .body { font-family: var(--font-mono); font-size: 12px; }
  .muted { color: var(--color-haze); margin: 4px 0; }
  .notice { color: var(--color-amber); margin: 4px 0; }
  .tools { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-bottom: 4px; }
  .s { background: #10131c; border: 1px solid var(--color-line); border-radius: 6px; color: inherit; font-family: var(--font-mono); font-size: 12px; padding: 2px 6px; width: 120px; }
  .count { color: var(--color-haze); min-width: 3ch; }
  button, .btn { background: #10131c; border: 1px solid var(--color-line); border-radius: 6px; cursor: pointer; color: #b7c0ff; font-family: var(--font-mono); font-size: 12px; padding: 2px 7px; text-decoration: none; }
  button:hover, .btn:hover { border-color: var(--color-violet); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.on { border-color: var(--color-violet); color: #fff; }
  .txt { margin: 0; white-space: pre-wrap; word-break: break-word; }
  .kv { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
  .kv td { border-top: 1px solid var(--color-line); padding: 1px 4px; word-break: break-word; }
  .kv td:first-child { color: var(--color-haze); width: 35%; }
  mark { background: #5a4a14; color: inherit; }
  mark.cur { background: #b8892a; color: #000; }
  .key { color: #7aa2f7; } .str { color: #9ece6a; } .num { color: #ff9e64; } .lit { color: #bb9af7; }
</style>
