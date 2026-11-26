<script>
  import { onMount, onDestroy, untrack } from 'svelte';
  import { api } from './api.js';
  import { studio } from './store.svelte.js';
  import {
    rowsOfNode, readOnlyReason, parseEdit, refusalText, splitError, readFailure, dupCount, dupText, nodeByIdPath,
    setAt, nodeRefOnPath, assertLine, effectiveId, NO_ID_TEXT, TOO_LARGE_TEXT,
  } from './nodestate.js';

  // Node State view (STUDIO-NS-T2): one node's fields (layer node) or its component's `m`, read through the agent's
  // `get` op (GET /api/state/node) and edited through /api/state/cmd, with the State tab's ack chip. Without a hub, a
  // token, or while the device is held elsewhere it says why instead of staying silent.
  let { node = null, sim = false, onadd = null } = $props();

  let layer = $state('node');       // node | m
  let typed = $state('');           // hand-typed id (simulator: there is no tree)
  let value = $state(null);         // last read, whole layer (or the loaded parts in large mode)
  let found = $state(true);
  let err = $state(null);           // { kind, text } of the last failed read, else null
  let large = $state(false);        // STATE_TOO_LARGE on the whole read: read one path at a time
  let readAt = $state(0);
  let now = $state(Date.now());
  let raw = $state(false);
  let editing = $state(null);       // { path, text, type }
  let chips = $state({});           // path -> { id, status, phase, error, step, code }
  let msg = $state('');
  let pathInput = $state('');
  let loadedPaths = $state([]);     // sub-paths read on top of the root read (load buttons, large mode)
  let busy = false, alive = true, timer = null, tick = null;

  const id = $derived(effectiveId(node, typed));
  const dups = $derived(node && node.id ? dupCount(studio.nodes, node.id) : 0);
  const rows = $derived(value && typeof value === 'object' ? rowsOfNode(value) : []);
  const pending = $derived(Object.values(chips).some((c) => c.status === 'pending'));
  const fieldNames = $derived(layer === 'node' && node ? Object.keys(node.attrs || {}) : []);
  const unread = $derived(fieldNames.filter((f) => !loadedPaths.includes(f)));
  const age = $derived(readAt ? Math.max(0, Math.round((now - readAt) / 1000)) : null);
  const failMsg = (r) => `${r.code || r.status}: ${r.error || 'request failed'}`;
  const fmt = (v, t) => (t === 'string' ? `"${v}"` : String(v));

  function reset() {
    value = null; found = true; err = null; large = false; readAt = 0; editing = null; chips = {}; msg = ''; loadedPaths = []; pathInput = '';
  }

  async function read(path = '') {
    const want = id, wantLayer = layer;
    if (!want) return;
    const r = await api.stateNode({ id: want, layer: wantLayer, path, raw });
    if (!alive || want !== id || wantLayer !== layer) return; // the selection moved while this was in flight
    readAt = Date.now(); now = readAt;
    if (!r.ok) {
      const f = readFailure(r);
      if (f.kind === 'large' && !path) { large = true; value = {}; loadedPaths = []; err = null; return; }
      if (f.kind === 'large') { msg = `${path}: ${TOO_LARGE_TEXT}`; return; }
      err = f; return;
    }
    err = null;
    if (!r.found) { if (!path) { value = null; found = false; } else msg = `${path}: not found`; return; }
    found = true;
    if (!path) { value = r.value; if (!large) loadedPaths = []; } else {
      value = setAt(value && typeof value === 'object' ? value : {}, path, r.value);
      if (!loadedPaths.includes(path)) loadedPaths = [...loadedPaths, path];
    }
  }
  async function guarded(fn) {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (e) { err = { kind: 'error', text: String((e && e.message) || e) }; } finally { busy = false; }
  }
  const reread = () => guarded(async () => {
    if (!id) return;
    if (large) { for (const p of [...loadedPaths]) await read(p); return; }
    const keep = [...loadedPaths];
    await read('');
    for (const p of keep) await read(p);
  });
  const refresh = () => { msg = ''; return reread(); };
  const load = (path) => guarded(() => read(path));

  // Reset and read when the node (its id) or the layer changes.
  $effect(() => {
    id; layer; raw;
    untrack(() => { reset(); busy = false; if (id) guarded(() => read('')); });
  });

  function startEdit(r) { if (!pendingFor(r.path)) editing = { path: r.path, type: r.type, text: r.type === 'string' ? r.value : JSON.stringify(r.value) }; }
  const pendingFor = (p) => chips[p] && chips[p].status === 'pending';

  async function commit() {
    if (!editing) return;
    const { path, text, type } = editing;
    const v = parseEdit(text, type);
    if (!v.ok) { msg = `${layer}.${path}: ${v.why}`; return; }
    editing = null; msg = '';
    try {
      const r = await api.stateCmd({ layer, node: { id }, path, value: v.value, ack: 'applied' }, raw);
      if (r.status === 423) { msg = 'Device is held elsewhere; edit not sent.'; return; }
      if (!r.ok) { chips[path] = { id: null, status: 'failed', phase: null, error: refusalText(failMsg(r), r.code), code: r.code }; return; }
      chips[path] = { id: r.id, status: 'pending', phase: null, error: null, step: r.step };
    } catch (e) { msg = `edit failed: ${e.message}`; }
  }
  async function pollPending() {
    for (const p of Object.keys(chips)) {
      const c = chips[p];
      if (c.status !== 'pending' || !c.id) continue;
      const r = await api.stateCmdStatus(c.id);
      if (!r.ok || !r.command) continue;
      const k = r.command;
      if (k.status === 'pending') { chips[p] = { ...c, phase: k.phase }; continue; }
      if (k.status === 'done') { chips[p] = { ...c, status: 'done', phase: k.phase || 'applied' }; await guarded(() => read(p)); }
      else chips[p] = { ...c, status: 'failed', phase: k.phase, error: refusalText(k.error || k.status), code: splitError(k.error).code };
    }
  }
  const chipClass = (c) => (c.status === 'failed' ? 'bad' : c.status === 'done' ? 'ok' : 'pend');
  const chipText = (c) => (c.status === 'failed' ? c.error || 'failed' : c.status === 'done' ? c.phase || 'done' : c.phase || 'sent');

  function goto(target) { const p = nodeByIdPath(studio.nodes, target); if (p) studio.selectedPath = p; }

  onMount(() => {
    const step = async () => {
      if (!alive) return;
      try {
        if (pending) await pollPending();
        else if (!editing && !busy && id && studio.page === 'inspect' && studio.live && document.visibilityState !== 'hidden') await reread();
      } catch { /* the next tick retries */ }
      if (alive) timer = setTimeout(step, pending ? 300 : 2000);
    };
    timer = setTimeout(step, 2000);
    tick = setInterval(() => { now = Date.now(); }, 1000);
  });
  onDestroy(() => { alive = false; clearTimeout(timer); clearInterval(tick); });
</script>

<div class="ns" data-testid="node-state">
  {#if node || !sim}
    {#if node && !node.id}
      <p class="empty" data-testid="node-state-noid">{NO_ID_TEXT}</p>
    {/if}
  {/if}
  {#if sim && !node}
    <div class="bar">
      <input class="f" data-testid="node-state-id" placeholder="node id (the simulator has no tree)" bind:value={typed} />
    </div>
  {/if}

  {#if id}
    <div class="bar">
      {#if !node}<span class="idl">#{id}</span>{/if}
      <span class="sw" role="group" aria-label="Layer">
        <button class:on={layer === 'node'} data-testid="node-state-layer-node" onclick={() => (layer = 'node')}>fields</button>
        <button class:on={layer === 'm'} data-testid="node-state-layer-m" onclick={() => (layer = 'm')}>m</button>
      </span>
      <button data-testid="node-state-refresh" onclick={refresh}>refresh</button>
      <button class:on={raw} data-testid="node-state-raw" onclick={() => (raw = !raw)}>{raw ? 'hide raw' : 'show raw'}</button>
      {#if age !== null}<span class="age" data-testid="node-state-age">read {age}s ago</span>{/if}
    </div>
    {#if dups > 1}<div class="dup" data-testid="node-state-dup">{dupText(dups, node.id)}</div>{/if}
    {#if raw}<div class="banner">Raw values are shown: this reveals what Studio masks on top of the app's own masking (configured redact paths).</div>{/if}
    {#if msg}<p class="msg err">{msg}</p>{/if}

    {#if err}
      <p class="empty err" data-testid="node-state-reason" data-kind={err.kind}>{err.text}</p>
    {/if}

    {#if large}
      <p class="empty" data-testid="node-state-large">{TOO_LARGE_TEXT} {layer === 'node' ? 'Pick a field to read it.' : 'Enter a path to read one part of m.'}</p>
      {#if layer === 'node'}
        <div class="names">
          {#each unread as f}<button data-testid="node-state-field" onclick={() => load(f)}>{f}</button>{/each}
        </div>
      {:else}
        <div class="bar">
          <input class="f" data-testid="node-state-path" placeholder="path in m, e.g. profile.name" bind:value={pathInput}
            onkeydown={(e) => { if (e.key === 'Enter' && pathInput.trim()) load(pathInput.trim()); }} />
          <button onclick={() => pathInput.trim() && load(pathInput.trim())}>read</button>
        </div>
      {/if}
    {/if}

    {#if !found}
      <p class="empty" data-testid="node-state-notfound">{layer === 'm' ? 'No m on this node.' : 'The agent found no fields for this node.'}</p>
    {/if}

    <dl class="rows" data-testid="node-state-rows">
      {#each rows as r}
        <div class="row" style="padding-left: {r.depth * 14}px">
          <dt>{r.key}</dt>
          {#if r.branch}
            <dd class="badge">{r.badge}</dd>
          {:else if editing && editing.path === r.path}
            <input class="f ed" data-testid="node-state-input" bind:value={editing.text}
              onkeydown={(e) => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') editing = null; }} />
            <button onclick={commit}>set</button>
          {:else}
            <dd class="valwrap">
              {#if r.kind === 'node'}
                <button class="val link" data-testid="node-state-goto" title={nodeByIdPath(studio.nodes, r.id) ? 'select that node' : 'not in the tree'}
                  disabled={!nodeByIdPath(studio.nodes, r.id)} onclick={() => goto(r.id)}>→ #{r.id}{r.subtype ? ` (${r.subtype})` : ''}</button>
              {:else if r.editable && !err}
                <button class="val {r.type} edit" data-testid="node-state-edit" title="click to edit" onclick={() => startEdit(r)}>{fmt(r.value, r.type)}</button>
              {:else}
                <span class="val {r.type}" title={readOnlyReason(r, { canEdit: !err, why: err && err.text })}>{fmt(r.value, r.type)}</span>
              {/if}
              {#if r.load}<button data-testid="node-state-load" title="read this sub-path" onclick={() => load(r.path)}>load</button>{/if}
            </dd>
            {#if chips[r.path]}
              {@const c = chips[r.path]}
              <span class="chip {chipClass(c)}" data-testid="node-state-chip" title={c.error || ''}>{chipText(c)}</span>
              {#if c.status === 'failed' && c.code === 'PATH_UNDER_NODE' && nodeRefOnPath(value, r.path)}
                <button data-testid="node-state-goto-under" onclick={() => goto(nodeRefOnPath(value, r.path))}>go to node</button>
              {/if}
              {#if onadd && c.step && c.status !== 'failed'}<button class="add on" data-testid="node-state-step" title="add this edit to the flow" onclick={() => onadd(c.step)}>+ setState step</button>{/if}
            {:else if onadd && assertLine(node, layer, r)}
              <button class="add" title="add assertField to the flow" onclick={() => onadd(assertLine(node, layer, r))}>+</button>
            {/if}
          {/if}
        </div>
      {/each}
    </dl>
    {#each Object.entries(chips).filter(([p, c]) => c.status === 'failed' && !rows.some((r) => r.path === p)) as [p, c]}
      <div class="chip bad" data-testid="node-state-chip">{p}: {c.error}</div>
    {/each}
  {:else if node}
    <!-- no id: the message above explains it -->
  {:else if !sim}
    <p class="empty">Select a node to read its state.</p>
  {/if}
</div>

<style>
  .empty { color: var(--color-haze); font-size: 13px; margin: 6px 0; line-height: 1.5; }
  .empty.err, .msg.err { color: var(--color-amber); }
  .msg { font-size: 12px; margin: 4px 0; }
  .banner { background: #2a1d10; color: var(--color-amber); border: 1px solid var(--color-amber); border-radius: 6px; font-size: 12px; padding: 4px 8px; margin: 6px 0; }
  .dup { background: #2a1d10; color: var(--color-amber); border: 1px solid rgba(255,194,75,.4); border-radius: 6px; font-size: 12px; padding: 4px 8px; margin: 6px 0; }
  .bar { display: flex; gap: 6px; align-items: center; margin: 6px 0; flex-wrap: wrap; }
  .idl { font-family: var(--font-mono); color: var(--color-violet); font-size: 13px; }
  .age { color: var(--color-haze); font-size: 11px; margin-left: auto; }
  .sw { display: inline-flex; gap: 0; }
  .sw button:first-child { border-radius: 6px 0 0 6px; } .sw button:last-child { border-radius: 0 6px 6px 0; border-left: none; }
  .f { flex: 1; min-width: 0; background: #10131c; border: 1px solid var(--color-line); border-radius: 6px; color: inherit; font-family: var(--font-mono); font-size: 12px; padding: 3px 7px; }
  button { background: #10131c; border: 1px solid var(--color-line); border-radius: 6px; cursor: pointer; color: #b7c0ff; font-family: var(--font-mono); font-size: 12px; padding: 3px 8px; }
  button:hover:not(:disabled) { border-color: var(--color-violet); }
  button:disabled { opacity: .5; cursor: default; }
  button.on { border-color: var(--color-violet); color: #fff; }
  .names { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0; }
  .rows { margin: 0; display: grid; gap: 1px; }
  .row { display: grid; grid-template-columns: 1fr auto auto auto; align-items: baseline; gap: 10px; padding: 3px 0; border-top: 1px solid var(--color-line); }
  dt { color: var(--color-haze); font-size: 12px; font-family: var(--font-mono); }
  dd { margin: 0; font-size: 12px; font-family: var(--font-mono); word-break: break-word; text-align: right; }
  .valwrap { display: inline-flex; justify-content: flex-end; gap: 6px; }
  button.val { background: none; border: none; padding: 0; font: inherit; }
  button.val.link { color: var(--color-violet); text-decoration: underline; }
  .val.edit { cursor: text; }
  .val.edit:hover { text-decoration: underline dotted; }
  .ed { grid-column: 2 / 4; }
  .badge { color: var(--color-haze); opacity: .7; }
  .val.string { color: #9ece6a; } .val.number { color: #ff9e64; } .val.boolean { color: var(--color-violet); } .val.null { color: var(--color-haze); }
  .chip { font-size: 11px; font-family: var(--font-mono); border: 1px solid var(--color-line); border-radius: 10px; padding: 0 7px; }
  .ok { color: #9ece6a; } .bad { color: var(--color-amber); } .pend { color: var(--color-haze); }
  .add { opacity: 0; transition: opacity .12s; padding: 2px 7px; }
  .add.on, .row:hover .add { opacity: 1; }
</style>
