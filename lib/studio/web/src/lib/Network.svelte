<script>
  import { onMount, tick } from 'svelte';
  import { api } from './api.js';
  import { noHubMessage, selectedRow, isRefused, refusedHost, refusedHint } from './net-state.js';
  import NetDetail from './NetDetail.svelte';
  import { splitKey, splitLimits, clampPct, pctFromPointer } from './drag.js';
  import { pickOrient, readPrefs, writePrefs, stepSelection, NET_KEY, DETAIL_MIN_SIDE, DETAIL_MIN_STACKED, LIST_MIN_PX } from './netdetail.js';

  // Network panel (NET-N-T10). Live rows come from the hub event stream (/api/bt/stream, redacted); the list is
  // reconciled from /api/net/requests. Raw values (headers, query secrets, bodies) load only after "show secrets".
  let { onadd = null } = $props();

  const MAX_ROWS = 500;
  let rows = $state([]);        // { id, method, host, path, status, ms, source, rule, bytes, error, headers, body }
  let selectedId = $state(null);
  let open = $state(false);       // details pane shown
  let prefs = $state(readPrefs(typeof localStorage !== 'undefined' ? localStorage.getItem(NET_KEY) : null));
  let splitEl = $state(null);
  let listEl = $state(null);
  let width = $state(0);
  let height = $state(0);
  let dragging = false;
  const orient = $derived(pickOrient(width, prefs.orient));
  const stacked = $derived(orient === 'stacked');
  const selected = $derived(selectedRow(rows, selectedId));
  let noHub = $state('');
  let filter = $state('');
  let raw = $state(false);
  let msg = $state('');
  let err = $state(false);
  let state = $state('connecting'); // connecting | live | down | none | locked
  let hellos = $state(null);    // hub hello count (null: unknown)
  let lastHelloAt = $state(null);
  let lastSeq = 0;
  let es = null;

  const say = (m, bad = false) => { msg = m; err = bad; };
  const split = (u) => { try { const x = new URL(u); return { host: x.host, path: x.pathname + x.search }; } catch { return { host: '', path: String(u) }; } };
  const cap = () => { if (rows.length > MAX_ROWS) rows = rows.slice(rows.length - MAX_ROWS); };
  const upsert = (id, patch) => {
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) rows = [...rows, { id, method: '', host: '', path: '', status: null, ms: null, source: null, rule: null, bytes: null, error: null, ...patch }];
    else rows[i] = { ...rows[i], ...patch };
    cap();
  };

  function onEvent(ev) {
    lastSeq = Math.max(lastSeq, ev.seq || 0);
    const d = ev.data || {};
    if (ev.kind === 'net.request') upsert(d.id, { method: d.method, ...split(d.url), rule: d.rule });
    else if (ev.kind === 'net.response') upsert(d.id, { status: d.status, source: d.source, bytes: d.bytes, ms: d.timings ? (d.timings.wait || 0) + (d.timings.receive || 0) : null });
    else if (ev.kind === 'net.error' && d.refused) upsert(d.id, { refused: true, source: 'refused', status: d.status || 403, bytes: d.bytes ?? null, error: 'refused' });
    else if (ev.kind === 'net.error') upsert(d.id, { error: d.kind, status: null });
  }

  async function probe() {
    // A plain GET tells locked / no hub apart before opening the stream (EventSource hides the status).
    try {
      const r = await fetch('/api/net/rules');
      if (r.status === 423) { state = 'locked'; return false; }
      if (r.status === 503) { noHub = noHubMessage(await r.json().catch(() => null)); state = 'none'; return false; }
      return r.ok;
    } catch { state = 'down'; return false; }
  }
  async function connect() {
    if (es) es.close();
    state = 'connecting';
    if (!(await probe())) return;
    await reload();
    es = new EventSource(api.btStreamUrl(lastSeq));
    es.onopen = () => { state = 'live'; };
    es.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch { /* ignore a malformed frame */ } };
    es.onerror = () => { state = 'down'; };
  }
  async function reload() {
    try {
      const d = await api.netRequests(raw, true);
      if (d.requests) rows = d.requests.map((r) => ({ ...r }));
      hellos = typeof d.hellos === 'number' ? d.hellos : null;
      lastHelloAt = typeof d.lastHelloAt === 'number' ? d.lastHelloAt : null;
    } catch { /* keep what we have */ }
  }

  const saveRaw = () => { try { localStorage.setItem(NET_KEY, writePrefs(prefs)); } catch { /* storage may be unavailable */ } };
  const limits = () => {
    return splitLimits(stacked ? height : width, LIST_MIN_PX, (stacked ? DETAIL_MIN_STACKED : DETAIL_MIN_SIDE) + 6, 30); // +6: the splitter
  };
  const setSize = (pct) => { prefs = { ...prefs, size: clampPct(pct, limits()) }; };
  const pct = $derived(clampPct(prefs.size, limits()));
  function splitDown(e) {
    dragging = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function splitMove(e) {
    if (!dragging || !splitEl) return;
    const r = splitEl.getBoundingClientRect();
    setSize(pctFromPointer(stacked ? e.clientY : e.clientX, stacked ? r.top : r.left, stacked ? r.height : r.width));
  }
  function splitUp() { if (dragging) { dragging = false; saveRaw(); } }
  function splitKeydown(e) {
    const n = splitKey(e.key, pct, limits(), stacked);
    if (n == null) return;
    e.preventDefault();
    setSize(n); saveRaw();
  }
  function splitReset() { setSize(50); saveRaw(); }
  function flip() { prefs = { ...prefs, orient: stacked ? 'side' : 'stacked' }; saveRaw(); }

  const rowEl = (id) => (listEl ? [...listEl.querySelectorAll('[data-testid="net-row"]')].find((x) => x.dataset.id === id) : null);
  const keepInView = () => tick().then(() => { const el = selectedId != null && rowEl(selectedId); if (el) el.scrollIntoView({ block: 'nearest' }); });
  const focusRow = () => tick().then(() => { const el = selectedId != null && rowEl(selectedId); if (el) el.focus(); });
  function select(id, opening = true) { selectedId = id; if (opening) open = true; keepInView(); }
  function closeDetail() { open = false; focusRow(); }
  function gridKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const id = stepSelection(shown.map((r) => r.id), selectedId, e.key === 'ArrowDown' ? 1 : -1);
      if (id != null) { selectedId = id; keepInView(); focusRow(); }
    } else if (e.key === 'Enter') { if (selectedId != null) { e.preventDefault(); open = true; keepInView(); } }
    else if (e.key === 'Escape' && open) { e.preventDefault(); closeDetail(); }
  }
  // Keep the selected row visible when the pane opens, resizes or flips; follow new rows only at the bottom of the list.
  let atBottom = true;
  $effect.pre(() => { void rows.length; if (listEl) atBottom = listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 4; });
  $effect(() => { void rows.length; if (listEl && atBottom) listEl.scrollTop = listEl.scrollHeight; });
  $effect(() => { void open; void pct; void orient; void width; void height; keepInView(); });

  async function toggleRaw() {
    raw = !raw;
    await reload();
  }
  function clear() { rows = []; selectedId = null; open = false; }

  async function mockThis(r) {
    const d = await api.netMockThis(r.id);
    if (d.error) return say(d.error, true);
    if (onadd) { onadd(d.step); say(`added mockHttp for ${r.method} ${r.path} (unsaved)`); }
    else say(d.step);
  }
  async function copyRule(r) {
    const d = await api.netMockThis(r.id);
    if (d.error) return say(d.error, true);
    try { await navigator.clipboard.writeText(JSON.stringify(d.rule, null, 2)); say('rule JSON copied'); } catch { say(JSON.stringify(d.rule), false); }
  }
  async function blockRule(r) {
    const d = await api.netRuleAdd({ method: r.method, url: `**${r.path.split('?')[0]}*`, kind: 'status', status: 503 });
    say(d.error ? d.error : 'block rule added for this session', !!d.error);
  }
  async function copyHost(r) {
    const h = refusedHost(r);
    try { await navigator.clipboard.writeText(JSON.stringify(h)); say(`copied "${h}": add it to upstreamHosts`); } catch { say(`add ${JSON.stringify(h)} to upstreamHosts`); }
  }
  async function clearRules() { const d = await api.netRulesClear(); say(d.error ? d.error : 'live rules cleared', !!d.error); }

  const shown = $derived(rows.filter((r) => !filter || `${r.method} ${r.host}${r.path} ${r.status ?? ''} ${r.source ?? ''}`.toLowerCase().includes(filter.toLowerCase())));
  const cls = (r) => (isRefused(r) ? 'refused' : r.error || (r.status && r.status >= 400) ? 'bad' : r.status ? 'ok' : 'pend');

  onMount(() => {
    connect();
    // While nothing has arrived, refresh so the hello hint updates once the device dials in.
    const t = setInterval(() => { if (state === 'live' && !rows.length) reload(); }, 3000);
    return () => { clearInterval(t); if (es) es.close(); };
  });
</script>

{#if state === 'none'}
  <p class="empty">{noHub}</p>
{:else if state === 'locked'}
  <p class="empty err">Studio does not hold the device lease. <button class="lnk" onclick={connect}>Retry</button></p>
{:else}
  <div class="net" data-testid="net-panel">
  <div class="bar">
    <input class="f" data-testid="net-filter" aria-label="filter requests" placeholder="filter" bind:value={filter} />
    <button data-testid="net-clear" onclick={clear} title="clear the view">Clear</button>
    <a class="btn" data-testid="net-export-har" href={api.netHarUrl()} download="brighttest-network.har" title="redacted HAR 1.2">Export HAR</a>
    <button class:on={raw} data-testid="net-show-secrets" aria-pressed={raw} onclick={toggleRaw}>show secrets</button>
  </div>
  {#if raw}<p class="banner">Raw values are shown: headers, query strings and bodies are not redacted. Do not share this view.</p>{/if}
  {#if state === 'down'}<p class="empty err">Stream disconnected, retrying. <button class="lnk" onclick={connect}>Reconnect</button></p>{/if}
  {#if msg}<p class="msg" class:err>{msg}</p>{/if}
  <div class="split" class:stacked bind:this={splitEl} bind:clientWidth={width} bind:clientHeight={height} style="--pct: {pct}%">
    <div class="list" bind:this={listEl} class:full={!open || !selected}>
      {#if !shown.length}
        {#if hellos === 0}
          <p class="empty">No hello from the device yet. The device sends its hello with the app's first HTTP request, so launch the app and use it. If nothing arrives, check the build has --net and the same hub token.</p>
        {:else if hellos > 0}
          <p class="empty">Device said hello at {lastHelloAt ? new Date(lastHelloAt).toLocaleTimeString() : 'an unknown time'}; no requests yet.</p>
        {:else}
          <p class="empty">No requests yet. Run the instrumented app; script HTTP calls appear here.</p>
        {/if}
      {:else}
        <table role="grid" data-testid="net-list" aria-label="network requests" onkeydown={gridKey}>
          <thead><tr><th>method</th><th>status</th><th>host / path</th><th>size</th><th>ms</th><th>source</th><th>rule</th></tr></thead>
          <tbody>
            {#each shown as r, i (r.id)}
              <tr data-testid="net-row" data-id={r.id} class:sel={selectedId === r.id} aria-selected={selectedId === r.id}
                  tabindex={selectedId === r.id || (selectedId == null && i === 0) ? 0 : -1} onclick={() => select(r.id)}>
                <td>{r.method}</td>
                <td class={cls(r)} title={isRefused(r) ? refusedHint(r) : ''}>{isRefused(r) ? 'refused' : r.error ? r.error : r.status ?? '...'}</td>
                <td class="path" title={r.host + r.path}>{r.host}{r.path}</td>
                <td>{r.bytes ?? ''}</td>
                <td>{r.ms ?? ''}</td>
                <td>{r.source ?? ''}</td>
                <td>{r.rule ?? ''}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
    {#if open && selected}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <div class="splitter" data-testid="net-detail-splitter" role="separator" tabindex="0" aria-orientation={stacked ? 'horizontal' : 'vertical'}
           aria-valuenow={Math.round(pct)} aria-valuemin="0" aria-valuemax="100" aria-label="resize details" aria-controls="net-detail-pane"
           onpointerdown={splitDown} onpointermove={splitMove} onpointerup={splitUp} onpointercancel={splitUp} onkeydown={splitKeydown} ondblclick={splitReset}></div>
      <div class="dpane" id="net-detail-pane">
        <NetDetail row={selected} {raw} orient={orient} onclose={closeDetail} onflip={flip}
          onmock={mockThis} oncopyrule={copyRule} onblock={blockRule} onclearrules={clearRules} oncopyhost={copyHost} />
      </div>
    {/if}
  </div>
  </div>
{/if}

<style>
  .empty { color: var(--color-haze); font-size: 13px; margin: 6px 0; line-height: 1.5; }
  .empty.err, .msg.err { color: var(--color-amber); }
  .msg { font-size: 12px; margin: 4px 0; color: var(--color-haze); }
  .banner { background: #2a1d10; color: var(--color-amber); border: 1px solid var(--color-amber); border-radius: 6px; font-size: 12px; padding: 4px 8px; margin: 6px 0; }
  .bar { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
  .f { flex: 1; background: #10131c; border: 1px solid var(--color-line); border-radius: 6px; color: inherit; font-family: var(--font-mono); font-size: 12px; padding: 3px 7px; }
  button, .btn { background: #10131c; border: 1px solid var(--color-line); border-radius: 6px; cursor: pointer; color: #b7c0ff; font-family: var(--font-mono); font-size: 12px; padding: 3px 8px; text-decoration: none; }
  button:hover, .btn:hover { border-color: var(--color-violet); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.on { border-color: var(--color-amber); color: var(--color-amber); }
  .lnk { border: none; background: none; text-decoration: underline; padding: 0; }
  table { width: 100%; border-collapse: collapse; font-family: var(--font-mono); font-size: 12px; }
  th { text-align: left; color: var(--color-haze); font-weight: normal; padding: 2px 4px; }
  td { padding: 2px 4px; border-top: 1px solid var(--color-line); white-space: nowrap; }
  td.path { max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
  tbody tr { cursor: pointer; }
  tr.sel { background: #161a28; }
  .refused { color: #f7768e; font-weight: 600; }
  .refused-hint { color: var(--color-amber); }
  .ok { color: #9ece6a; } .bad { color: var(--color-amber); } .pend { color: var(--color-haze); }
  .net { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .split { flex: 1; min-height: 0; display: flex; flex-direction: row; }
  .split.stacked { flex-direction: column; }
  .list { flex: 0 0 var(--pct); min-width: 0; min-height: 0; overflow: auto; }
  .split.stacked .list { flex: 0 0 var(--pct); }
  .list.full { flex: 1; }
  .dpane { flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
  .splitter { flex: 0 0 6px; background: var(--color-line); cursor: col-resize; touch-action: none; }
  .split.stacked .splitter { cursor: row-resize; }
  .splitter:hover, .splitter:focus-visible { background: var(--color-violet); outline: none; }
  tr:focus-visible { outline: 1px solid var(--color-violet); outline-offset: -1px; }
</style>
