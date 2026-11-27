<script>
  import { api } from './api.js';
  import BodyView from './BodyView.svelte';
  import { isRefused, refusedHint, canMock } from './net-state.js';
  import { generalRows, notInHarText, redactionText, headersText, queryPairs, buildCurl } from './netdetail.js';

  // Details of the selected request (design 5.2): actions, General, Headers, Payload and Response tabs. The entry is
  // fetched from /api/net/entry on selection, on a raw toggle, and once more when a pending row completes (its row
  // changes through the event stream), never on a timer.
  let { row, raw = false, onclose, onmock, oncopyrule, onblock, onclearrules, oncopyhost, onflip, orient = 'side' } = $props();

  let tab = $state('headers');
  let d = $state(null);
  let loading = $state(false);
  let failed = $state('');
  let note = $state('');
  let token = 0;

  const sig = $derived(row ? `${row.id}|${raw}|${row.status}|${row.bytes}|${row.error}|${row.source}` : '');
  $effect(() => {
    void sig;
    if (!row) { d = null; return; }
    const my = ++token;
    const keep = d && d.id === row.id;
    if (!keep) d = null;
    loading = !keep; failed = '';
    api.netEntry(row.id, raw).then((r) => {
      if (my !== token) return;
      loading = false;
      if (r.ok && r.id) d = r; else { failed = r.error || `HTTP ${r.status}`; if (!keep) d = null; }
    }).catch(() => { if (my === token) { loading = false; failed = 'could not load the details'; } });
  });

  const rows = $derived(generalRows(d, row));
  const notInHar = $derived(notInHarText(d));
  const refused = $derived(isRefused(row) || (d && d.source === 'refused'));
  const query = $derived(d ? queryPairs(d.url) : []);
  async function copyText(label, text) {
    try { await navigator.clipboard.writeText(text); note = `${label} copied`; } catch { note = `could not copy ${label}`; }
  }
  function onkey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onclose(); }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section class="nd" data-testid="net-detail" aria-label="request details" onkeydown={onkey}>
  <div class="top">
    <div class="acts">
      <button data-testid="net-mock-this" onclick={() => onmock(row)} disabled={!canMock(row)} title={!canMock(row) ? 'No completed exchange to mock (unmatched, refused or failed request)' : 'Add a mockHttp step from this response'}>Mock this</button>
      <button data-testid="net-copy-rule" onclick={() => oncopyrule(row)} disabled={!canMock(row)} title={!canMock(row) ? 'No completed exchange to copy (unmatched, refused or failed request)' : 'Copy the rule JSON for this response'}>Copy as rule JSON</button>
      <button data-testid="net-copy-curl" title={d && d.raw ? 'Copy as cURL (raw values: secrets included)' : 'Copy as cURL (secrets replaced by a placeholder)'} disabled={!d} onclick={() => copyText(d && d.raw ? 'cURL (raw)' : 'cURL', buildCurl(d))}>Copy as cURL</button>
      <button data-testid="net-block" onclick={() => onblock(row)}>Block (503)</button>
      <button data-testid="net-clear-rules" onclick={onclearrules}>Clear live rules</button>
    </div>
    <div class="acts">
      <button data-testid="net-detail-orient" onclick={onflip} aria-label="flip the split" title="flip between side by side and stacked">{orient === 'side' ? 'Stack' : 'Side'}</button>
      <button data-testid="net-detail-close" onclick={onclose} aria-label="close details" title="close (Esc)">&times;</button>
    </div>
  </div>
  <div class="tabs" role="tablist">
    {#each [['headers', 'Headers'], ['payload', 'Payload'], ['response', 'Response']] as [k, label]}
      <button role="tab" aria-selected={tab === k} class:on={tab === k} data-testid={'net-detail-tab-' + k} onclick={() => (tab = k)}>{label}</button>
    {/each}
    {#if note}<span class="note">{note}</span>{/if}
  </div>
  {#if raw}<p class="banner">Raw values are shown. Do not share this view.</p>{/if}
  <div class="pane">
    {#if failed}
      <p class="err">{failed}</p>
    {:else if !d}
      <p class="muted">{loading ? 'Loading...' : 'No details.'}</p>
    {:else if tab === 'headers'}
      <div data-testid="net-detail-general" class="gen">
        <dl>
          {#each rows as [k, v]}<div class="r"><dt>{k}</dt><dd>{v}</dd></div>{/each}
          <div class="r"><dt>Redaction</dt><dd><span class="badge" data-testid="net-redaction-badge" class:rawb={d.raw}>{redactionText(d)}</span></dd></div>
          {#if notInHar}<div class="r"><dt>HAR</dt><dd data-testid="net-not-in-har">{notInHar}</dd></div>{/if}
        </dl>
        <button data-testid="net-copy-url" onclick={() => copyText('URL', d.url)}>Copy URL</button>
        {#if refused}
          <p class="hint" data-testid="net-refused-hint">{refusedHint(row)} <button onclick={() => oncopyhost(row)}>Allow this host (copy entry)</button></p>
        {/if}
      </div>
      <h4>Request headers <button data-testid="net-copy-req-headers" onclick={() => copyText('request headers', headersText(d.request.headers))}>Copy</button></h4>
      <dl data-testid="net-detail-req-headers">
        {#each Object.entries(d.request.headers || {}) as [k, v]}<div class="r"><dt>{k}</dt><dd>{v}</dd></div>{:else}<p class="muted">none</p>{/each}
      </dl>
      <h4>Response headers <button data-testid="net-copy-res-headers" onclick={() => copyText('response headers', headersText(d.response.headers))}>Copy</button></h4>
      <dl data-testid="net-detail-res-headers">
        {#each Object.entries(d.response.headers || {}) as [k, v]}<div class="r"><dt>{k}</dt><dd>{v}</dd></div>{:else}<p class="muted">none</p>{/each}
      </dl>
    {:else if tab === 'payload'}
      {#if query.length}
        <h4>Query parameters</h4>
        <table class="kv" data-testid="net-query"><tbody>{#each query as [k, v]}<tr><td>{k}</td><td>{v}</td></tr>{/each}</tbody></table>
      {/if}
      {#key d.id}<BodyView view={d.request.body} side="req" id={d.id} {raw} contentType={d.request.contentType} />{/key}
    {:else}
      {#key d.id}<BodyView view={d.response.body} side="res" id={d.id} {raw} contentType={d.response.contentType} />{/key}
    {/if}
  </div>
</section>

<style>
  .nd { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; font-family: var(--font-mono); font-size: 12px; }
  .top { display: flex; justify-content: space-between; gap: 6px; flex-wrap: wrap; margin-bottom: 4px; }
  .acts { display: flex; flex-wrap: wrap; gap: 4px; }
  .tabs { display: flex; gap: 2px; align-items: center; border-bottom: 1px solid var(--color-line); }
  .tabs button { border-radius: 6px 6px 0 0; border-bottom: none; }
  .note { margin-left: auto; color: var(--color-haze); }
  .pane { flex: 1; min-height: 0; overflow: auto; padding-top: 4px; }
  .muted { color: var(--color-haze); } .err { color: var(--color-amber); }
  .banner { background: #2a1d10; color: var(--color-amber); border: 1px solid var(--color-amber); border-radius: 6px; padding: 3px 8px; margin: 4px 0; }
  .hint { color: var(--color-amber); line-height: 1.5; }
  .badge { border: 1px solid var(--color-line); border-radius: 10px; padding: 0 6px; }
  .badge.rawb { border-color: var(--color-amber); color: var(--color-amber); }
  h4 { margin: 8px 0 2px; color: var(--color-haze); font-weight: normal; }
  dl { margin: 0; }
  .r { display: grid; grid-template-columns: minmax(70px, 1fr) 3fr; gap: 8px; padding: 1px 0; border-top: 1px solid var(--color-line); }
  dt { color: var(--color-haze); } dd { margin: 0; word-break: break-word; }
  .kv { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
  .kv td { border-top: 1px solid var(--color-line); padding: 1px 4px; word-break: break-word; }
  .kv td:first-child { color: var(--color-haze); width: 35%; }
  button { background: #10131c; border: 1px solid var(--color-line); border-radius: 6px; cursor: pointer; color: #b7c0ff; font-family: var(--font-mono); font-size: 12px; padding: 2px 7px; }
  button:hover { border-color: var(--color-violet); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.on { border-color: var(--color-violet); color: #fff; }
</style>
