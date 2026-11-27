<script>
  import { onMount } from 'svelte';
  import { studio } from '../store.svelte.js';
  import { api } from '../api.js';
  import { isSim } from '../simbadge.js';
  import { STEP_LABELS, SORTS, fmtBytes, ago, sourceKinds, filterBuilds, sortBuilds, allTags, precheck, uploadError, failureText, installError, currentLine, loadPrefs, savePrefs, needsConfirm } from '../builds.js';

  const store = typeof localStorage === 'undefined' ? null : localStorage;
  let builds = $state([]);
  let info = $state(null); // { scope, count, totalBytes, caps }
  let warnings = $state([]);
  let cur = $state(null);
  let lease = $state(null);
  let loadErr = $state('');
  let q = $state('');
  let fKind = $state('');
  let fSource = $state('');
  let fPinned = $state(false);
  let fTag = $state('');
  let sort = $state('newest');
  let selId = $state(null);
  let uploads = $state([]); // { n, name, loaded, total, state: 'sending'|'checking'|'created'|'deduped'|'error', text }
  let over = $state(false);
  let prefs = $state(store ? loadPrefs(store) : { confirm: true });
  let dialog = $state(null); // { build, token: bool, skip: bool }
  let job = $state(null); // { id, build, steps, log, running, result, tokenCheck }
  let msg = $state('');
  let askDelete = $state(false);
  let upN = 0;
  let es = null;
  let fileInput;

  const sim = $derived(isSim(studio.device));
  const shown = $derived(sortBuilds(filterBuilds(builds, { q, kind: fKind, source: fSource, pinned: fPinned, tag: fTag }), sort));
  const sel = $derived(builds.find((b) => b.id === selId) || null);
  const tags = $derived(allTags(builds));
  const maxMB = $derived(info?.caps?.maxZipMB || 64);
  const devName = $derived((cur?.device && (cur.device.name || cur.device.model)) || cur?.host || 'the device');
  const leaseText = $derived.by(() => {
    const h = lease?.holder;
    if (!lease) return 'lease …';
    if (h) return h.mine ? 'held by Studio' : `in use by ${h.agent}${h.purpose ? ' (' + h.purpose + ')' : ''}`;
    return 'free';
  });

  async function load() {
    const r = await api.builds().catch(() => null);
    if (!r || !r.ok) { loadErr = (r && r.error) || 'could not load builds'; return; }
    loadErr = '';
    builds = r.builds || []; info = { ...r.store, scope: r.store?.scope }; warnings = r.warnings || [];
    if (selId && !builds.some((b) => b.id === selId)) selId = null;
  }
  async function loadCurrent() {
    if (sim) { cur = null; return; }
    cur = await api.buildsCurrent().catch(() => null);
    if (cur && !cur.ok) cur = { error: cur.error || 'no device', status: cur.status };
    lease = await api.lease().catch(() => null);
  }
  onMount(() => {
    load(); loadCurrent();
    const t = setInterval(() => { if (!document.hidden && !job?.running) loadCurrent(); }, 10000);
    return () => { clearInterval(t); es?.close(); };
  });

  // ---- upload: one file after another ----
  let chain = Promise.resolve();
  function addFiles(files) {
    for (const f of files) {
      const row = $state({ n: ++upN, name: f.name, loaded: 0, total: f.size, state: 'sending', text: '' });
      uploads.push(row);
      const r = uploads[uploads.length - 1];
      const bad = precheck(f, maxMB);
      if (bad) { r.state = 'error'; r.text = bad; continue; }
      chain = chain.then(async () => {
        const res = await api.buildUpload(f, (l, t) => { r.loaded = l; r.total = t; if (l >= t) r.state = 'checking'; });
        if (res.ok) { r.state = res.created ? 'created' : 'deduped'; r.text = res.created ? `added ${res.build.label}` : `already stored as ${res.build.label}`; selId = res.build.id; }
        else { r.state = 'error'; r.text = uploadError(res.code, res.error, maxMB); }
        await load();
      });
    }
  }
  const onDrop = (e) => { e.preventDefault(); over = false; if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]); };
  const onPick = (e) => { addFiles([...e.currentTarget.files]); e.currentTarget.value = ''; };

  // ---- edit ----
  async function edit(b, body) {
    const r = await api.buildEdit(b.id, body);
    msg = r.ok ? '' : r.error || 'save failed';
    await load();
  }
  const saveTags = (b, text) => edit(b, { tags: text.split(/[\s,]+/).filter(Boolean) });
  async function del(b) {
    askDelete = false;
    const r = await api.buildDelete(b.id);
    msg = r.ok ? '' : r.code === 'BUILD_PINNED' ? 'Unpin the build before deleting it.' : r.error || 'delete failed';
    await load();
  }

  // ---- install ----
  function startInstall(b) {
    msg = '';
    if (needsConfirm(prefs, false)) dialog = { build: b, token: false, skip: false };
    else doInstall(b, false);
  }
  async function confirmInstall() {
    const d = dialog;
    if (d.skip && !d.token) { prefs = { confirm: false }; if (store) savePrefs(store, prefs); }
    dialog = null;
    await doInstall(d.build, d.token);
  }
  async function doInstall(b, allow) {
    const r = await api.buildInstall(b.id, allow);
    if (r.status === 202) return follow(r.jobId, b, r.tokenCheck);
    const e = installError(r.status, r);
    if (e.kind === 'token') dialog = { build: b, token: true, skip: false };
    else if (e.kind === 'locked') { msg = e.text; await loadCurrent(); }
    else msg = e.text;
  }
  function follow(id, b, tokenCheck) {
    es?.close();
    job = { id, build: b, steps: [], log: [], running: true, result: null, tokenCheck };
    es = new EventSource(api.buildJobUrl(id));
    es.onmessage = (m) => {
      let ev; try { ev = JSON.parse(m.data); } catch { return; }
      if (ev.type === 'step') job.steps.push(ev.step);
      else if (ev.type === 'log') job.log.push(ev.line);
      else if (ev.type === 'done') { job.running = false; job.result = ev.result; es.close(); load(); loadCurrent(); }
    };
    es.onerror = () => { if (job && job.running && es.readyState === 2) { job.running = false; job.result = { ok: false, code: 'NETWORK', message: 'lost the progress stream' }; } };
  }
  const cancelJob = () => api.buildJobCancel(job.id);
  const launch = () => api.launch('dev');
  const inspect = () => { studio.page = 'inspect'; };
  const failed = $derived(job?.result && !job.result.ok ? failureText(job.result) : null);
  const copy = (t) => navigator.clipboard?.writeText(t).catch(() => {});
</script>

<div class="page" data-testid="page-builds" role="region" aria-label="Builds"
  ondragover={(e) => { e.preventDefault(); over = true; }} ondragleave={() => (over = false)} ondrop={onDrop}>
  <div class="phead"><h1>Builds</h1></div>

  <div class="strip" role="status" aria-label="Device">
    <span data-testid="builds-current">{currentLine(cur, { sim })}</span>
    <span class="chip" data-testid="builds-lease">{leaseText}</span>
  </div>

  <div class="drop" class:over data-testid="builds-drop">
    <span>Drop .zip files here or <button class="link" onclick={() => fileInput.click()}>Choose files</button> (up to {maxMB} MB)</span>
    <input bind:this={fileInput} type="file" accept=".zip,application/zip" multiple data-testid="builds-file-input" aria-label="Choose zip files" onchange={onPick} hidden />
    {#if info}<span class="store" data-testid="builds-store">{info.scope} store, {info.count} build{info.count === 1 ? '' : 's'}, {fmtBytes(info.totalBytes)} of {info.caps?.maxTotalMB} MB</span>{/if}
  </div>

  {#each uploads as u (u.n)}
    <div class="up" data-testid="builds-upload-{u.n}" data-state={u.state}>
      <b>{u.name}</b>
      {#if u.state === 'sending'}<span>{fmtBytes(u.loaded)} / {fmtBytes(u.total)}</span>
      {:else if u.state === 'checking'}<span>checking package</span>
      {:else if u.state === 'error'}<span class="err" data-testid="builds-upload-error">{u.text}</span>
      {:else}<span class="ok">{u.text}</span>{/if}
    </div>
  {/each}

  {#if loadErr}<p class="err" role="alert">{loadErr}</p>{/if}
  {#if msg}<p class="err" data-testid="builds-message" role="alert">{msg}</p>{/if}
  {#each warnings as w}<p class="warn">{typeof w === 'string' ? w : w.message || JSON.stringify(w)}</p>{/each}

  <div class="tools">
    <input type="search" placeholder="Search label, file, notes, tag, version, sha" aria-label="Search builds" data-testid="builds-search" bind:value={q} />
    <select aria-label="Kind" data-testid="builds-filter-kind" bind:value={fKind}><option value="">any kind</option><option value="store">store</option><option value="instrumented">instrumented</option></select>
    <select aria-label="Source" data-testid="builds-filter-source" bind:value={fSource}><option value="">any source</option><option value="build">build</option><option value="upload">upload</option><option value="cli">CLI</option></select>
    <select aria-label="Tag" data-testid="builds-filter-tag" bind:value={fTag}><option value="">any tag</option>{#each tags as t}<option value={t}>{t}</option>{/each}</select>
    <label><input type="checkbox" data-testid="builds-filter-pinned" bind:checked={fPinned} /> pinned</label>
    <select aria-label="Sort" data-testid="builds-sort" bind:value={sort}>{#each SORTS as s}<option value={s.id}>{s.label}</option>{/each}</select>
  </div>

  <div class="cols">
    <ul class="list" aria-label="Builds" data-testid="builds-list">
      {#each shown as b (b.id)}
        <li>
          <button class="row" class:sel={b.id === selId} data-testid="builds-row-{b.id}" aria-current={b.id === selId ? 'true' : undefined} onclick={() => { selId = b.id; askDelete = false; }}>
            <span class="star" aria-label={b.pinned ? 'pinned' : ''}>{b.pinned ? '★' : ''}</span>
            <span class="main"><b>{b.label}</b><small>{b.filename}</small></span>
            <span>{b.manifest?.version || ''}</span>
            <span class="badge">{b.kind}</span>
            <span class="meta">{sourceKinds(b).join(', ')}</span>
            <span class="meta">{fmtBytes(b.size)}</span>
            <span class="meta">{ago(b.createdAt)}</span>
            <span class="meta">{#if b.lastInstall}<i class="res" class:bad={!b.lastInstall.ok}>{b.lastInstall.ok ? 'ok' : 'failed'}</i> {ago(b.lastInstall.at)}{/if}</span>
            <span class="meta">{b.installCount || 0}×</span>
          </button>
        </li>
      {:else}
        <li class="empty">{builds.length ? 'No builds match.' : 'No builds yet. Drop a .zip to add one.'}</li>
      {/each}
    </ul>

    {#if sel}
      <section class="detail" data-testid="builds-detail" aria-label="Build details">
        <h2>{sel.label}</h2>
        <div class="acts">
          <button class="go" data-testid="builds-install" disabled={sim || job?.running || sel.installing} onclick={() => startInstall(sel)}>Install</button>
          <a class="btn" data-testid="builds-download" href={api.buildDownloadUrl(sel.id)} download>Download</a>
          <button class="btn" data-testid="builds-pin" onclick={() => edit(sel, { pinned: !sel.pinned })}>{sel.pinned ? 'Unpin' : 'Pin'}</button>
          {#if askDelete}
            <span>Delete this build? <button class="btn danger" data-testid="builds-delete-yes" onclick={() => del(sel)}>Delete</button> <button class="btn" onclick={() => (askDelete = false)}>Keep</button></span>
          {:else}
            <button class="btn danger" data-testid="builds-delete" onclick={() => (askDelete = true)}>Delete</button>
          {/if}
        </div>
        <dl>
          <dt>Label</dt><dd><input aria-label="Label" data-testid="builds-label" value={sel.label} onchange={(e) => edit(sel, { label: e.currentTarget.value })} /></dd>
          <dt>File</dt><dd>{sel.filename} · {fmtBytes(sel.size)}</dd>
          <dt>Version</dt><dd>{sel.manifest?.title || ''} {sel.manifest?.version || ''}</dd>
          <dt>Kind</dt><dd>{sel.kind}{sel.markerKinds?.length ? ` (${sel.markerKinds.join(', ')})` : ''}</dd>
          <dt>sha256</dt><dd class="mono">{sel.sha256} <button class="link" onclick={() => copy(sel.sha256)}>copy</button></dd>
          {#if sel.git}<dt>Git</dt><dd class="mono">{sel.git.sha} {sel.git.branch}{sel.git.dirty ? ' (dirty)' : ''}</dd>{/if}
          <dt>Tags</dt><dd><input aria-label="Tags" data-testid="builds-tags" value={(sel.tags || []).join(', ')} placeholder="qa, nightly" onchange={(e) => saveTags(sel, e.currentTarget.value)} /></dd>
          <dt>Notes</dt><dd><textarea aria-label="Notes" data-testid="builds-notes" maxlength="4096" rows="3" onblur={(e) => { if (e.currentTarget.value !== (sel.notes || '')) edit(sel, { notes: e.currentTarget.value }); }}>{sel.notes || ''}</textarea></dd>
        </dl>
        <h3>Install history</h3>
        <ul class="hist" data-testid="builds-history">
          {#each [...(sel.installs || [])].reverse() as i}
            <li class:bad={!i.ok}>{ago(i.at)} · {i.via} · {i.device || i.host || ''} · {i.ok ? 'ok' : `failed at ${i.error?.step || '?'}: ${i.error?.code || ''}${i.error?.cause ? ' (' + i.error.cause + ')' : ''} ${i.error?.message || ''}`}</li>
          {:else}<li class="empty">never installed</li>{/each}
        </ul>
      </section>
    {/if}
  </div>

  {#if job}
    <section class="job" data-testid="builds-job" aria-live="polite">
      <b>Installing {job.build.label}</b>
      <ol>
        {#each job.steps as s}<li data-testid="builds-job-step-{s}">{STEP_LABELS[s] || s}</li>{/each}
      </ol>
      {#each job.log as l}<p class="warn">{l}</p>{/each}
      {#if job.running}<button class="btn" data-testid="builds-job-cancel" onclick={cancelJob}>Cancel</button>{/if}
      {#if job.result}
        <div class="result" data-testid="builds-job-result" data-ok={job.result.ok ? 'true' : 'false'}>
          {#if job.result.ok}
            <b class="ok">Installed; dev channel running</b>
            <button class="btn" data-testid="builds-job-inspect" onclick={inspect}>Inspect</button>
            <button class="btn" data-testid="builds-job-launch" onclick={launch}>Launch again</button>
          {:else}
            <b class="err">{failed.headline}</b>
            {#if failed.cause}<span class="mono"> {failed.cause}</span>{/if}
            <p>{failed.message}</p>
            {#if failed.hint}<p class="hint">{failed.hint}</p>{/if}
          {/if}
        </div>
      {/if}
    </section>
  {/if}

  {#if dialog}
    <div class="modal" role="dialog" aria-modal="true" aria-label="Install build" data-testid="builds-confirm">
      <div class="box">
        <p>Install <b>{dialog.build.label}</b> on <b>{devName}</b>{cur?.device?.model ? ` (${cur.device.model})` : ''}? This <b>replaces the dev channel</b> on that device. Now installed: {cur?.build ? cur.build.label : 'unknown build'}.</p>
        {#if dialog.token}
          <p class="warn" data-testid="builds-token-warning">This build was made with a different hub token (or Studio has none): the State and Network panels will not connect to it. Rebuild with <code>instrument build --net</code> using Studio's token, or install anyway.</p>
        {:else}
          <label><input type="checkbox" data-testid="builds-confirm-skip" bind:checked={dialog.skip} /> don't ask again in this browser</label>
        {/if}
        <div class="acts">
          <button class="go" data-testid="builds-confirm-ok" onclick={confirmInstall}>{dialog.token ? 'Install anyway' : 'Install'}</button>
          <button class="btn" data-testid="builds-confirm-cancel" onclick={() => (dialog = null)}>Cancel</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .page { padding: 28px 32px; max-width: 1400px; }
  h1 { font-family: var(--font-display); font-size: 22px; font-weight: 700; margin: 0 0 14px; letter-spacing: -.01em; }
  h2 { font-size: 16px; margin: 0 0 8px; } h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .1em; color: var(--color-haze); margin: 14px 0 6px; }
  .strip { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid var(--color-line); border-radius: 10px; background: var(--color-panel); margin-bottom: 12px; }
  .chip, .badge { font-size: 11px; border: 1px solid var(--color-line2); border-radius: 999px; padding: 2px 10px; color: var(--color-haze); }
  .strip .chip { margin-left: auto; }
  .drop { display: flex; justify-content: space-between; gap: 12px; padding: 18px; border: 1px dashed var(--color-line2); border-radius: 10px; margin-bottom: 10px; color: var(--color-haze); }
  .drop.over { border-color: var(--color-violet); background: var(--color-panel); }
  .store { font-family: var(--font-mono); font-size: 12px; }
  .link { background: none; border: none; color: var(--color-violet); cursor: pointer; padding: 0; font: inherit; text-decoration: underline; }
  .up { display: flex; gap: 12px; font-size: 12px; padding: 4px 2px; font-family: var(--font-mono); }
  .ok { color: var(--color-pass); } .err { color: var(--color-fail); } .warn { color: var(--color-amber); font-size: 12px; margin: 4px 0; } .hint { color: var(--color-haze); }
  .tools { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 12px 0; font-size: 12px; }
  .tools input[type=search] { flex: 1; min-width: 220px; }
  input, select, textarea { background: var(--color-panel2); color: var(--color-text); border: 1px solid var(--color-line2); border-radius: 6px; padding: 6px 8px; font: inherit; font-size: 12px; }
  textarea { width: 100%; box-sizing: border-box; }
  .cols { display: grid; grid-template-columns: minmax(0, 2.2fr) minmax(300px, 1fr); gap: 14px; align-items: start; }
  .list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .row { display: grid; grid-template-columns: 16px minmax(100px, 2fr) 60px 90px 60px 60px 60px 90px 30px; gap: 8px; align-items: center; width: 100%; text-align: left; padding: 9px 10px; border: 1px solid var(--color-line); border-radius: 8px; background: var(--color-panel); color: var(--color-text); cursor: pointer; font-size: 12px; }
  .row.sel { border-color: var(--color-violet); }
  .main { display: flex; flex-direction: column; min-width: 0; } .main small, .meta { color: var(--color-haze); }
  .star { color: var(--color-amber); }
  .res { font-style: normal; color: var(--color-pass); } .res.bad { color: var(--color-fail); }
  .empty { color: var(--color-haze); padding: 12px; }
  .detail, .job { border: 1px solid var(--color-line); border-radius: 10px; background: var(--color-panel); padding: 14px; font-size: 12px; }
  .job { margin-top: 14px; }
  dl { display: grid; grid-template-columns: 70px 1fr; gap: 6px 10px; margin: 10px 0; } dt { color: var(--color-haze); } dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .mono { font-family: var(--font-mono); }
  .acts { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .go { background: var(--color-violet); color: #0c0e14; font-weight: 700; border: none; border-radius: 8px; padding: 7px 16px; cursor: pointer; font-size: 12px; }
  .btn { background: var(--color-panel2); color: var(--color-text); border: 1px solid var(--color-line2); border-radius: 8px; padding: 6px 14px; cursor: pointer; font-size: 12px; text-decoration: none; }
  .btn.danger { color: var(--color-fail); } .go:disabled { opacity: .5; cursor: default; }
  .hist { list-style: none; padding: 0; margin: 0; display: grid; gap: 4px; } .hist li.bad { color: var(--color-fail); }
  ol { margin: 8px 0; padding-left: 20px; }
  .result { margin-top: 8px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; } .result p { flex-basis: 100%; margin: 2px 0; }
  .modal { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: grid; place-items: center; z-index: 50; }
  .box { background: var(--color-panel); border: 1px solid var(--color-line2); border-radius: 12px; padding: 20px; max-width: 460px; font-size: 13px; line-height: 1.5; }
</style>
