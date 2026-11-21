<script>
  import { onMount } from 'svelte';
  import { api } from './api.js';

  // Network panel (NET-N-T10). Live rows come from the hub event stream (/api/bt/stream, redacted); the list is
  // reconciled from /api/net/requests. Raw values (headers, query secrets, bodies) load only after "show secrets".
  let { onadd = null } = $props();

  const MAX_ROWS = 500;
  let rows = $state([]);        // { id, method, host, path, status, ms, source, rule, bytes, error, headers, body }
  let selected = $state(null);
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
    if (ev.kind === 'net.request') upsert(d.id, { method: d.method, ...split(d.url), rule: d.rule, headers: d.headers });
    else if (ev.kind === 'net.response') upsert(d.id, { status: d.status, source: d.source, bytes: d.bytes, ms: d.timings ? (d.timings.wait || 0) + (d.timings.receive || 0) : null });
    else if (ev.kind === 'net.error') upsert(d.id, { error: d.kind, status: null });
  }

  async function probe() {
    // A plain GET tells locked / no hub apart before opening the stream (EventSource hides the status).
    try {
      const r = await fetch('/api/net/rules');
      if (r.status === 423) { state = 'locked'; return false; }
      if (r.status === 503) { state = 'none'; return false; }
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
      const d = await api.netRequests(raw);
      if (d.requests) rows = d.requests.map((r) => ({ ...r }));
      hellos = typeof d.hellos === 'number' ? d.hellos : null;
      lastHelloAt = typeof d.lastHelloAt === 'number' ? d.lastHelloAt : null;
    } catch { /* keep what we have */ }
  }

  async function toggleRaw() {
    raw = !raw;
    await reload();
    if (!raw && selected) selected = rows.find((r) => r.id === selected.id) || null;
  }
  function clear() { rows = []; selected = null; }

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
  async function clearRules() { const d = await api.netRulesClear(); say(d.error ? d.error : 'live rules cleared', !!d.error); }

  const shown = $derived(rows.filter((r) => !filter || `${r.method} ${r.host}${r.path} ${r.status ?? ''} ${r.source ?? ''}`.toLowerCase().includes(filter.toLowerCase())));
  const cls = (r) => (r.error || (r.status && r.status >= 400) ? 'bad' : r.status ? 'ok' : 'pend');

  onMount(() => {
    connect();
    // While nothing has arrived, refresh so the hello hint updates once the device dials in.
    const t = setInterval(() => { if (state === 'live' && !rows.length) reload(); }, 3000);
    return () => { clearInterval(t); if (es) es.close(); };
  });
</script>

{#if state === 'none'}
  <p class="empty">No instrument hub is running in this Studio session, so there is no network traffic to show.</p>
{:else if state === 'locked'}
  <p class="empty err">Studio does not hold the device lease. <button class="lnk" onclick={connect}>Retry</button></p>
{:else}
  <div class="bar">
    <input class="f" placeholder="filter" bind:value={filter} />
    <button onclick={clear} title="clear the view">Clear</button>
    <a class="btn" href={api.netHarUrl()} download="brighttest-network.har" title="redacted HAR 1.2">Export HAR</a>
    <button class:on={raw} onclick={toggleRaw}>show secrets</button>
  </div>
  {#if raw}<p class="banner">Raw values are shown: headers, query strings and bodies are not redacted. Do not share this view.</p>{/if}
  {#if state === 'down'}<p class="empty err">Stream disconnected, retrying. <button class="lnk" onclick={connect}>Reconnect</button></p>{/if}
  {#if msg}<p class="msg" class:err>{msg}</p>{/if}
  {#if !shown.length}
    {#if hellos === 0}
      <p class="empty">No hello from the device yet. The device sends its hello with the app's first HTTP request, so launch the app and use it. If nothing arrives, check the build has --net and the same hub token.</p>
    {:else if hellos > 0}
      <p class="empty">Device said hello at {lastHelloAt ? new Date(lastHelloAt).toLocaleTimeString() : 'an unknown time'}; no requests yet.</p>
    {:else}
      <p class="empty">No requests yet. Run the instrumented app; script HTTP calls appear here.</p>
    {/if}
  {:else}
    <table>
      <thead><tr><th>method</th><th>status</th><th>host / path</th><th>size</th><th>ms</th><th>source</th><th>rule</th></tr></thead>
      <tbody>
        {#each shown as r (r.id)}
          <tr class:sel={selected && selected.id === r.id} onclick={() => (selected = r)}>
            <td>{r.method}</td>
            <td class={cls(r)}>{r.error ? r.error : r.status ?? '...'}</td>
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
  {#if selected}
    <div class="detail">
      <div class="acts">
        <button onclick={() => mockThis(selected)}>Mock this</button>
        <button onclick={() => copyRule(selected)}>Copy as rule JSON</button>
        <button onclick={() => blockRule(selected)}>Block (503)</button>
        <button onclick={clearRules}>Clear live rules</button>
      </div>
      {#if selected.headers}
        <dl class="rows">
          {#each Object.entries(selected.headers) as [k, v]}
            <div class="row"><dt>{k}</dt><dd>{v}</dd></div>
          {/each}
        </dl>
      {/if}
      {#if selected.body}<pre>{selected.body}</pre>{/if}
    </div>
  {/if}
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
  button.on { border-color: var(--color-amber); color: var(--color-amber); }
  .lnk { border: none; background: none; text-decoration: underline; padding: 0; }
  table { width: 100%; border-collapse: collapse; font-family: var(--font-mono); font-size: 12px; }
  th { text-align: left; color: var(--color-haze); font-weight: normal; padding: 2px 4px; }
  td { padding: 2px 4px; border-top: 1px solid var(--color-line); white-space: nowrap; }
  td.path { max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
  tbody tr { cursor: pointer; }
  tr.sel { background: #161a28; }
  .ok { color: #9ece6a; } .bad { color: var(--color-amber); } .pend { color: var(--color-haze); }
  .detail { margin-top: 8px; border-top: 1px solid var(--color-line); padding-top: 6px; }
  .acts { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
  .rows { margin: 0; display: grid; gap: 1px; }
  .row { display: grid; grid-template-columns: 1fr 2fr; gap: 10px; padding: 2px 0; border-top: 1px solid var(--color-line); }
  dt { color: var(--color-haze); font-size: 12px; font-family: var(--font-mono); }
  dd { margin: 0; font-size: 12px; font-family: var(--font-mono); word-break: break-word; }
  pre { font-size: 12px; font-family: var(--font-mono); white-space: pre-wrap; word-break: break-word; max-height: 160px; overflow: auto; }
</style>
