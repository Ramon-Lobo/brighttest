<script>
  import { onMount, onDestroy } from 'svelte';
  import { api } from './api.js';
  import { rowsOf } from './rows.js';
  import AppState from './AppState.svelte';

  // State inspector (STA-S-T8). The live tree is the app's __bt_agent node as /api/state serves it (read over ECP,
  // redacted); the hub adds edits, snapshots and the ack of each command. An edit goes through /api/state/cmd (the
  // flow-step validator) and shows an ack chip: received, applied, reflected, or the error. Raw values load only
  // after "show raw". Without a hub, or while the device is held elsewhere, it falls back to the read-only view.
  let { onadd = null } = $props();

  const EDITABLE = ['global', 'scene', 'registry'];
  const PLACEHOLDER = /^<redacted:[^>]*>$/; // the agent masks secret-looking keys itself; a marker is not a real value
  let st = $state('connecting');   // connecting | live | locked | none | down
  let info = $state(null);         // last GET /api/state body
  let raw = $state(false);
  let msg = $state('');
  let err = $state(false);
  let editing = $state(null);      // { layer, path, text, type }
  let chips = $state({});          // `${layer}.${path}` -> { id, phase, status, error, step }
  let history = $state([]);        // local edit log, newest first: { t, label, id }
  let snapName = $state('');
  let diffA = $state('');
  let diffB = $state('');
  let diff = $state(null);
  let timer = null;
  let alive = true;

  const say = (m, bad = false) => { msg = m; err = bad; };
  const failMsg = (r) => `${r.code || r.status}: ${r.error || 'request failed'}`;
  const fmt = (v, t) => (t === 'string' ? `"${v}"` : String(v));
  const yamlVal = (v, t) => (t === 'string' ? JSON.stringify(v) : String(v));
  const stamp = () => new Date().toTimeString().slice(0, 8);
  const layers = $derived(info && info.layers && typeof info.layers === 'object' ? info.layers : null);
  const hubUp = $derived(!!(info && info.hellos > 0));
  const snapshots = $derived(info ? info.snapshots || [] : []);
  const cmdById = $derived(Object.fromEntries(((info && info.commands) || []).map((c) => [c.id, c])));
  const pending = $derived(Object.values(chips).some((c) => c.status === 'pending'));
  // Registry values are written one <section>.<key> at a time, so only depth 1 is editable; a structured value is read only.
  const editable = (layer, r) => EDITABLE.includes(layer) && !(r.type === 'string' && PLACEHOLDER.test(r.value)) && (layer !== 'registry' || r.depth === 1);

  function gate(r) {
    if (r.status === 423) { st = 'locked'; return false; }
    if (r.status === 503) { st = 'none'; return false; }
    return true;
  }
  async function refresh() {
    try {
      const r = await api.state(raw);
      if (!alive || !gate(r)) return;
      if (!r.ok) { st = 'down'; return; }
      info = r; st = 'live';
      for (const k of Object.keys(chips)) {
        const c = r.commands.find((x) => x.id === chips[k].id);
        if (c) chips[k] = { ...chips[k], phase: c.phase, status: c.status, error: c.error };
      }
    } catch { st = 'down'; }
  }
  // While an edit waits for its ack, poll just those commands by id (hub only, no tree read) so the chip can walk
  // received, applied, reflected; the layers reload once, after the last one settles. Otherwise a full refresh every 2 s.
  async function pollPending() {
    for (const k of Object.keys(chips)) {
      const c = chips[k];
      if (c.status !== 'pending' || !c.id) continue;
      const r = await api.stateCmdStatus(c.id);
      if (!gate(r)) return;
      if (r.ok && r.command) chips[k] = { ...c, phase: r.command.phase, status: r.command.status, error: r.command.error };
    }
    if (!Object.values(chips).some((c) => c.status === 'pending')) await refresh();
  }
  function schedule() {
    if (!alive) return;
    timer = setTimeout(async () => {
      try { if (pending) await pollPending(); else if (!editing) await refresh(); } catch { st = 'down'; }
      schedule();
    }, pending ? 300 : 2000);
  }

  // The edit keeps the field's current type: a string field stays a string ("123" is not turned into 123).
  function parseValue(text, type) {
    if (type === 'string') return { ok: true, value: text };
    if (type === 'number') { const n = Number(text); return text.trim() !== '' && Number.isFinite(n) ? { ok: true, value: n } : { ok: false, why: 'enter a number' }; }
    if (type === 'boolean') return text === 'true' || text === 'false' ? { ok: true, value: text === 'true' } : { ok: false, why: 'enter true or false' };
    try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: true, value: text }; }
  }
  function startEdit(layer, r) {
    if (!editable(layer, r)) return;
    editing = { layer, path: r.path, type: r.type, text: r.type === 'string' ? r.value : JSON.stringify(r.value) };
  }

  async function commit() {
    if (!editing) return;
    const { layer, path, text, type } = editing;
    const v = parseValue(text, type);
    if (!v.ok) return say(`${layer}.${path}: ${v.why}`, true);
    editing = null;
    try {
      const r = await api.stateCmd({ layer, path, value: v.value, ack: 'reflected' }, raw);
      if (!gate(r)) return say('Device is held elsewhere; edit not sent.', true);
      if (!r.ok) { chips[`${layer}.${path}`] = { id: null, phase: null, status: 'failed', error: failMsg(r) }; return say(failMsg(r), true); }
      chips[`${layer}.${path}`] = { id: r.id, phase: null, status: 'pending', error: null, step: r.step };
      history = [{ t: stamp(), label: `${layer}.${path} = ${JSON.stringify(v.value)}`, id: r.id }, ...history].slice(0, 50);
      say('');
      refresh();
    } catch (e) { say(`edit failed: ${e.message}`, true); }
  }
  const chipText = (c) => (c.status === 'failed' || c.status === 'timeout' || c.status === 'abandoned' ? (c.error || c.status) : c.status === 'done' ? (c.phase || 'done') : (c.phase || 'sent'));
  const chipClass = (c) => (c.status === 'failed' || c.status === 'timeout' || c.status === 'abandoned' ? 'bad' : c.status === 'done' ? 'ok' : 'pend');

  // Run one async UI action; a network or parse failure becomes a visible message, never an unhandled rejection.
  async function act(fn) { try { await fn(); } catch (e) { say(String((e && e.message) || e), true); } }

  const saveSnap = () => act(async () => {
    const name = snapName.trim() || `snap-${Date.now().toString(36)}`;
    say('saving snapshot…');
    const r = await api.stateSnapshotAct('save', name);
    if (!gate(r) || !r.ok) return say(failMsg(r), true);
    snapName = ''; say(`saved ${name}`); refresh();
  });
  const restoreSnap = (name) => act(async () => {
    const r = await api.stateSnapshotAct('restore', name);
    if (!gate(r) || !r.ok) return say(failMsg(r), true);
    history = [{ t: stamp(), label: `restore ${name}`, id: r.id }, ...history].slice(0, 50);
    say(r.note ? `restoring ${name}: ${r.note}` : `restoring ${name}…`); refresh();
  });
  const delSnap = (name) => act(async () => {
    const r = await api.stateSnapshotDelete(name);
    if (!gate(r) || !r.ok) return say(failMsg(r), true);
    if (diffA === name) diffA = '';
    if (diffB === name) diffB = '';
    diff = null;
    refresh();
  });
  const exportSnap = (name) => act(async () => {
    const r = await api.stateSnapshotGet(name, raw);
    if (!gate(r) || !r.ok) return say(failMsg(r), true);
    const blob = new Blob([JSON.stringify({ name, redacted: !raw, layers: r.layers }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `${name}.state.json`; a.click();
    URL.revokeObjectURL(a.href);
    say(raw ? `exported ${name} (RAW values)` : `exported ${name} (redacted)`);
  });
  const importFile = (ev) => act(async () => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!f) return;
    let doc;
    try { doc = JSON.parse(await f.text()); } catch { return say('not a JSON file', true); }
    const L = doc && doc.layers && typeof doc.layers === 'object' ? doc.layers : doc;
    const name = (doc && typeof doc.name === 'string' && /^[A-Za-z0-9_.-]+$/.test(doc.name) ? doc.name : f.name.replace(/\.state\.json$|\.json$/, '').replace(/[^A-Za-z0-9_.-]/g, '_')) || 'imported';
    const r = await api.stateSnapshotAct('import', name, L);
    if (!gate(r) || !r.ok) return say(failMsg(r), true);
    say(doc && doc.redacted ? `imported ${name}: it was exported redacted, so its masked values are skipped on restore` : `imported ${name}`);
    refresh();
  });
  const runDiff = () => act(async () => {
    if (!diffA || !diffB) return;
    const r = await api.stateDiff(diffA, diffB, raw);
    if (!gate(r) || !r.ok) return say(failMsg(r), true);
    diff = r.diff;
  });
  const toggleRaw = () => act(async () => { raw = !raw; diff = null; await refresh(); });

  onMount(() => { refresh(); schedule(); });
  onDestroy(() => { alive = false; clearTimeout(timer); });
</script>

{#if st === 'none'}
  <p class="empty">No instrument hub is running in Studio. It starts while Studio holds the device lease and <code>BRIGHTTEST_HUB_TOKEN</code> is set.</p>
  <AppState {onadd} />
{:else if st === 'locked'}
  <p class="empty err">Device is held by another session, so the live state is unavailable. Take the device in the header to inspect and edit.</p>
  <AppState {onadd} />
{:else if !info}
  {#if st === 'down'}<p class="empty err">State routes unreachable. Retrying.</p>{/if}
  <AppState {onadd} />
{:else}
  {#if !hubUp}
    <p class="empty">The app has not connected to the hub yet (no agent hello): edits and snapshots wait for it. The published state is shown read only.</p>
  {/if}
  {#if raw}<div class="banner">Raw values are shown: this reveals what Studio masks on top of the app's own masking (configured redact paths). Exports in this mode are not redacted.</div>{/if}
  {#if hubUp}
    <div class="bar">
      <button class:on={raw} onclick={toggleRaw}>{raw ? 'hide raw' : 'show raw'}</button>
      <input class="f" placeholder="snapshot name" bind:value={snapName} />
      <button onclick={saveSnap}>save</button>
      <label class="btn">import<input type="file" accept="application/json,.json" onchange={importFile} hidden /></label>
    </div>
  {/if}
  {#if msg}<p class="msg" class:err>{msg}</p>{/if}

  {#if layers}
    {#each Object.keys(layers) as name}
      <h4 class="layer">{name}{#if layers[name].truncated && layers[name].truncated.length}<span class="trunc" title={layers[name].truncated.join(', ')}> truncated ({layers[name].truncated.length})</span>{/if}</h4>
      <dl class="rows">
        {#each rowsOf(layers[name].state) as r}
          <div class="row" style="padding-left: {r.depth * 14}px">
            <dt>{r.key}</dt>
            {#if r.branch}
              <dd class="badge">{r.badge}</dd>
            {:else if editing && editing.layer === name && editing.path === r.path}
              <input class="f ed" bind:value={editing.text}
                onkeydown={(e) => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') editing = null; }} />
              <button onclick={commit}>set</button>
            {:else}
              <dd class="valwrap">
                {#if hubUp && editable(name, r)}
                  <button class="val {r.type} edit" title="click to edit" onclick={() => startEdit(name, r)}>{fmt(r.value, r.type)}</button>
                {:else}
                  <span class="val {r.type}" title={!EDITABLE.includes(name) ? 'read only layer' : !hubUp ? 'waiting for the hub' : r.type === 'string' && PLACEHOLDER.test(r.value) ? 'masked field: not a real value, cannot be edited' : name === 'registry' && r.depth !== 1 ? 'edit the whole registry value, not a part of it' : 'read only'}>{fmt(r.value, r.type)}</span>
                {/if}
              </dd>
              {#if chips[`${name}.${r.path}`]}
                {@const c = chips[`${name}.${r.path}`]}
                <span class="chip {chipClass(c)}" title={c.error || ''}>{chipText(c)}</span>
                {#if onadd && c.step}<button class="add on" title="add this edit to the flow" onclick={() => onadd(c.step)}>+ setState step</button>{/if}
              {:else if onadd}
                <button class="add" title="add assertState to flow"
                  onclick={() => onadd(`- assertState: { layer: ${name}, path: ${r.path}, equals: ${yamlVal(r.value, r.type)} }`)}>+</button>
              {/if}
            {/if}
          </div>
        {/each}
      </dl>
    {/each}
  {:else}
    <p class="empty err">{info.agentReadFailed ? `Device read failed, retrying (${info.agentError}).` : info.agentError ? `Agent state is unreadable: ${info.agentError}` : 'No agent layers published by the app.'}</p>
  {/if}

  {#if hubUp}
    <h4 class="layer">snapshots</h4>
    {#if !snapshots.length}<p class="empty">None yet. Save one, or import an exported file.</p>{/if}
    {#each snapshots as s}
      <div class="snap">
        <span class="nm">{s.name}</span>
        <button onclick={() => restoreSnap(s.name)}>restore</button>
        <button onclick={() => exportSnap(s.name)}>export</button>
        <button onclick={() => delSnap(s.name)}>delete</button>
      </div>
    {/each}
    {#if snapshots.length > 1}
      <div class="bar">
        <select class="f" bind:value={diffA}><option value="">diff from…</option>{#each snapshots as s}<option value={s.name}>{s.name}</option>{/each}</select>
        <select class="f" bind:value={diffB}><option value="">to…</option>{#each snapshots as s}<option value={s.name}>{s.name}</option>{/each}</select>
        <button onclick={runDiff}>diff</button>
      </div>
      {#if diff}
        {#if !diff.length}<p class="empty">No differences.</p>{/if}
        {#each diff as d}
          <div class="drow"><span class={d.op === 'del' ? 'bad' : 'ok'}>{d.op === 'del' ? '-' : '+'}</span> <code>{d.layer}.{d.path}</code>{#if d.op !== 'del'} = <code>{JSON.stringify(d.value)}</code>{/if}</div>
        {/each}
      {/if}
    {/if}

    <h4 class="layer">history</h4>
    {#if !history.length}<p class="empty">Edits and restores made here appear with their ack phase.</p>{/if}
    {#each history as h}
      {@const c = cmdById[h.id]}
      <div class="drow"><span class="pend">{h.t}</span> <code>{h.label}</code>
        {#if c}<span class="chip {chipClass(c)}">{chipText(c)}</span>{/if}</div>
    {/each}
  {/if}
{/if}

<style>
  .empty { color: var(--color-haze); font-size: 13px; margin: 6px 0; line-height: 1.5; }
  .empty code { font-family: var(--font-mono); color: var(--color-violet); font-size: 12px; }
  .empty.err, .msg.err { color: var(--color-amber); }
  .msg { font-size: 12px; margin: 4px 0; color: var(--color-haze); }
  .banner { background: #2a1d10; color: var(--color-amber); border: 1px solid var(--color-amber); border-radius: 6px; font-size: 12px; padding: 4px 8px; margin: 6px 0; }
  .bar { display: flex; gap: 6px; align-items: center; margin: 6px 0; }
  .f { flex: 1; min-width: 0; background: #10131c; border: 1px solid var(--color-line); border-radius: 6px; color: inherit; font-family: var(--font-mono); font-size: 12px; padding: 3px 7px; }
  button, .btn { background: #10131c; border: 1px solid var(--color-line); border-radius: 6px; cursor: pointer; color: #b7c0ff; font-family: var(--font-mono); font-size: 12px; padding: 3px 8px; }
  button:hover, .btn:hover { border-color: var(--color-violet); }
  button.on { border-color: var(--color-amber); color: var(--color-amber); }
  .rows { margin: 0; display: grid; gap: 1px; }
  .row { display: grid; grid-template-columns: 1fr auto auto auto; align-items: baseline; gap: 10px; padding: 3px 0; border-top: 1px solid var(--color-line); }
  dt { color: var(--color-haze); font-size: 12px; font-family: var(--font-mono); }
  dd { margin: 0; font-size: 12px; font-family: var(--font-mono); word-break: break-word; text-align: right; }
  .valwrap { display: inline-flex; justify-content: flex-end; }
  button.val { background: none; border: none; padding: 0; font: inherit; }
  .val.edit { cursor: text; }
  .val.edit:hover { text-decoration: underline dotted; }
  .trunc { color: var(--color-amber); font-weight: normal; }
  .ed { grid-column: 2 / 4; }
  .layer { margin: 10px 0 4px; font-size: 12px; font-family: var(--font-mono); color: var(--color-violet); }
  .badge { color: var(--color-haze); opacity: .7; }
  .val.string { color: #9ece6a; } .val.number { color: #ff9e64; } .val.boolean { color: var(--color-violet); } .val.null { color: var(--color-haze); }
  .chip { font-size: 11px; font-family: var(--font-mono); border: 1px solid var(--color-line); border-radius: 10px; padding: 0 7px; }
  .ok { color: #9ece6a; } .bad { color: var(--color-amber); } .pend { color: var(--color-haze); }
  .add { opacity: 0; transition: opacity .12s; padding: 2px 7px; }
  .add.on, .row:hover .add { opacity: 1; }
  .snap { display: flex; gap: 6px; align-items: center; padding: 2px 0; border-top: 1px solid var(--color-line); }
  .snap .nm { flex: 1; font-family: var(--font-mono); font-size: 12px; }
  .drow { font-size: 12px; font-family: var(--font-mono); padding: 2px 0; border-top: 1px solid var(--color-line); word-break: break-word; }
</style>
