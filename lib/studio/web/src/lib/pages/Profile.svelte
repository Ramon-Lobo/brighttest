<script>
  import { api } from '../api.js';

  // ── live session state ────────────────────────────────────────────────────────────────────────
  // One crosshair time shared by all three charts, so hovering one aligns the readout on the others.
  let hoverT = $state(null);
  let running = $state(false);
  let exists = $state(false);
  let samples = $state([]);
  let markers = $state([]);
  let intervalMs = $state(1000);
  let sessErr = $state('');
  let pollTimer = null;

  async function refresh() {
    const s = await api.perfSession(samples.length);
    if (!s.exists) { exists = false; running = false; return; }
    exists = true; running = s.running; sessErr = s.error || '';
    if (s.samples.length) samples = [...samples, ...s.samples];
    markers = s.markers;
  }
  async function start() {
    samples = []; markers = [];
    await api.perfStart(intervalMs);
    running = true; exists = true;
    poll();
  }
  async function stop() { await api.perfStop(); running = false; }
  async function mark() { await api.perfMarker('marker ' + (markers.length + 1)); refresh(); }
  function poll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => { await refresh().catch(() => {}); if (running) poll(); }, Math.max(500, intervalMs));
  }
  $effect(() => { refresh().then(() => { if (running) poll(); }).catch(() => {}); return () => clearTimeout(pollTimer); });

  const MB = 1024 * 1024;
  const last = $derived(samples.length ? samples[samples.length - 1] : null);
  const fmtClock = (t) => { const s = Math.floor(t / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  // ── chart series (validated palette: violet #7c6cff + dark amber #c08a1e on #141824) ─────────
  const cpuSeries = $derived([
    { name: 'user', color: '#7c6cff', pts: samples.map((s) => ({ t: s.t, v: s.cpuUser })) },
    { name: 'sys', color: '#c08a1e', pts: samples.map((s) => ({ t: s.t, v: s.cpuSys })) },
  ]);
  const memSeries = $derived([
    { name: 'used', color: '#7c6cff', pts: samples.map((s) => ({ t: s.t, v: s.memUsed === null ? null : s.memUsed / MB })) },
    { name: 'anon (heap)', color: '#c08a1e', pts: samples.map((s) => ({ t: s.t, v: s.memAnon === null ? null : s.memAnon / MB })) },
  ]);
  const memLimit = $derived(last && last.memLimit ? last.memLimit / MB : null);
  const texSeries = $derived([
    { name: 'texture', color: '#7c6cff', pts: samples.map((s) => ({ t: s.t, v: s.texUsed === null ? null : s.texUsed / MB })) },
  ]);
  const texMax = $derived(last && last.texMax ? last.texMax / MB : null);
  // Page faults arrive as cumulative counters; chart the per-sample delta (faults since last sample).
  const deltas = (key) => samples.map((s, i) => ({
    t: s.t,
    v: s[key] === null || i === 0 || samples[i - 1][key] === null ? (i === 0 ? 0 : null) : Math.max(0, s[key] - samples[i - 1][key]),
  }));
  const faultSeries = $derived([
    { name: 'minor', color: '#7c6cff', pts: deltas('minflt') },
    { name: 'major', color: '#c08a1e', pts: deltas('majflt') },
  ]);

  // ── texture inventory ─────────────────────────────────────────────────────────────────────────
  let textures = $state(null);
  let texErr = $state('');
  async function snapshotTextures() {
    texErr = '';
    const r = await api.perfTextures();
    if (r.error) { texErr = r.error; textures = null; } else textures = r;
  }

  // ── perfetto ──────────────────────────────────────────────────────────────────────────────────
  let pf = $state(null);
  let pfErr = $state('');
  let pfBusy = $state(false);
  async function pfRefresh() { pf = await api.perfettoStatus().catch(() => null); }
  async function pfAct(action) {
    pfBusy = true; pfErr = '';
    const r = await api.perfettoAction(action).finally(() => (pfBusy = false));
    if (r.error) pfErr = r.error;
    await pfRefresh();
  }
  $effect(() => { pfRefresh(); });

  // ── device console (:8080) ────────────────────────────────────────────────────────────────────
  let conOut = $state('');
  let conErr = $state('');
  let conStatus = $state('');
  let conBusy = $state(false);
  const CONSOLE_CMDS = ['free', 'sgperf_start', 'sgperf_report', 'sgperf_stop', 'loaded_textures', 'fps_display_on', 'fps_display_off', 'logrendezvous_on', 'logrendezvous_off'];
  async function consoleRun(command) {
    conBusy = true; conErr = ''; conStatus = '';
    const r = await api.perfConsole(command).finally(() => (conBusy = false));
    if (r.status) conStatus = `status: ${r.status} - ${r.reason || ''}`;
    if (r.error) { conErr = r.error; return; }
    let head = `> ${command}`;
    if (r.parsed && r.parsed.ok && r.parsed.threads) {
      head += '\n' + r.parsed.threads.map((t) => `  ${t.name}  creates=${t.creates ?? '—'} ops=${t.ops ?? '—'} rendezvous=${t.rendezvousPct ?? '—'}%`).join('\n');
    }
    conOut = `${head}\n${r.raw}\n\n${conOut}`.slice(0, 20000);
  }

  // ── bsprof report ─────────────────────────────────────────────────────────────────────────────
  let report = $state(null);
  let bsprofErr = $state('');
  let pulling = $state(false);
  let sortKey = $state('cpuSelf');
  let sortAsc = $state(false);

  async function importFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    bsprofErr = '';
    const r = await api.perfBsprofImport(await file.arrayBuffer());
    if (r.error) { bsprofErr = r.error; report = null; } else report = r;
    e.target.value = '';
  }
  async function pullFromDevice() {
    pulling = true; bsprofErr = '';
    const r = await api.perfBsprofPull().finally(() => (pulling = false));
    if (r.error) { bsprofErr = r.error; } else report = r;
  }
  function sortBy(k) { if (sortKey === k) sortAsc = !sortAsc; else { sortKey = k; sortAsc = false; } }
  const rows = $derived.by(() => {
    if (!report) return [];
    const dir = sortAsc ? 1 : -1;
    return [...report.functions]
      .sort((a, b) => (a[sortKey] > b[sortKey] ? dir : a[sortKey] < b[sortKey] ? -dir : 0))
      .slice(0, 100);
  });
  const pct = (v) => `${v.toFixed(1)}%`;
  const kb = (v) => (v >= 1024 ? `${(v / 1024).toFixed(1)} KB` : `${v} B`);
</script>

<!-- Minimal line chart. One y-axis; series direct-labeled at the line end plus a legend; dashed
     reference line for a capacity ceiling; hover crosshair with a readout of every series. -->
{#snippet chart(title, series, unit, refValue, refLabel)}
  {@const W = 560}
  {@const H = 150}
  {@const PAD = { l: 44, r: 74, t: 10, b: 18 }}
  {@const pts0 = series[0].pts}
  {@const tMax = Math.max(1, ...pts0.map((p) => p.t))}
  {@const vAll = series.flatMap((s) => s.pts.map((p) => p.v)).filter((v) => v !== null)}
  {@const vTop = Math.max(refValue || 0, 1, ...vAll) * 1.1}
  {@const px = (t) => PAD.l + (t / tMax) * (W - PAD.l - PAD.r)}
  {@const py = (v) => H - PAD.b - (v / vTop) * (H - PAD.t - PAD.b)}
  {@const line = (pts) => pts.filter((p) => p.v !== null).map((p, i) => `${i ? 'L' : 'M'}${px(p.t).toFixed(1)},${py(p.v).toFixed(1)}`).join(' ')}
  <div class="chart card">
    <div class="charthead">
      <span class="eyebrow">{title}</span>
      {#if series.length > 1}
        <span class="legend">
          {#each series as s}<span class="key"><i style="background:{s.color}"></i>{s.name}</span>{/each}
        </span>
      {/if}
    </div>
    {#if !vAll.length}
      <p class="empty">no data yet</p>
    {:else}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_mouse_events_have_key_events -->
      <svg viewBox="0 0 {W} {H}" role="img" aria-label={title}
        onmousemove={(e) => { const r = e.currentTarget.getBoundingClientRect(); hoverT = ((e.clientX - r.left) / r.width * W - PAD.l) / (W - PAD.l - PAD.r) * tMax; }}
        onmouseleave={() => (hoverT = null)}>
        <!-- recessive grid: quarter lines only -->
        {#each [0.25, 0.5, 0.75] as f}
          <line x1={PAD.l} x2={W - PAD.r} y1={py(vTop * f)} y2={py(vTop * f)} class="grid" />
        {/each}
        <text x={PAD.l - 6} y={py(0) + 4} class="tick" text-anchor="end">0</text>
        <text x={PAD.l - 6} y={py(vTop) + 10} class="tick" text-anchor="end">{Math.round(vTop)}{unit}</text>
        {#if refValue}
          <line x1={PAD.l} x2={W - PAD.r} y1={py(refValue)} y2={py(refValue)} class="ref" />
          <text x={W - PAD.r + 4} y={py(refValue) + 3} class="tick">{refLabel}</text>
        {/if}
        {#each markers as m}
          {#if m.t <= tMax}<line x1={px(m.t)} x2={px(m.t)} y1={PAD.t} y2={H - PAD.b} class="mark" />{/if}
        {/each}
        {#each series as s}
          <path d={line(s.pts)} fill="none" stroke={s.color} stroke-width="2" />
          {@const lastPt = [...s.pts].reverse().find((p) => p.v !== null)}
          {#if lastPt}
            <text x={px(lastPt.t) + 4} y={py(lastPt.v) + 3} class="dlabel" fill={s.color}>{s.name} {lastPt.v.toFixed(unit === '%' ? 1 : 0)}</text>
          {/if}
        {/each}
        {#if hoverT !== null && hoverT >= 0 && hoverT <= tMax}
          {@const near = pts0.reduce((b, p) => (Math.abs(p.t - hoverT) < Math.abs(b.t - hoverT) ? p : b), pts0[0])}
          <line x1={px(near.t)} x2={px(near.t)} y1={PAD.t} y2={H - PAD.b} class="cross" />
          <g transform="translate({Math.min(px(near.t) + 6, W - 150)}, {PAD.t + 4})">
            <rect width="118" height={14 * (series.length + 1)} rx="4" class="tipbg" />
            <text x="6" y="11" class="tip">{fmtClock(near.t)}</text>
            {#each series as s, i}
              {@const sp = s.pts.reduce((b, p) => (Math.abs(p.t - near.t) < Math.abs(b.t - near.t) ? p : b), s.pts[0])}
              <text x="6" y={11 + 14 * (i + 1)} class="tip" fill={s.color}>{s.name}: {sp.v === null ? '—' : sp.v.toFixed(1)}{unit}</text>
            {/each}
          </g>
        {/if}
      </svg>
    {/if}
  </div>
{/snippet}

<div class="profile">
  <div class="controls card">
    <div class="eyebrow">live profiling <span class="tip2">polls /query/chanperf + /query/r2d2-bitmaps</span></div>
    <div class="row">
      {#if running}
        <button class="stop" onclick={stop}>■ Stop</button>
      {:else}
        <button class="go" onclick={start}>● Start session</button>
      {/if}
      <label class="ivl">every
        <select bind:value={intervalMs} disabled={running}>
          <option value={500}>0.5s</option><option value={1000}>1s</option><option value={2000}>2s</option><option value={5000}>5s</option>
        </select>
      </label>
      <button class="ghost" onclick={mark} disabled={!running}>+ marker</button>
      <span class="spacer"></span>
      <a class="ghost btn" href="/api/perf/export?format=json" class:off={!exists} download>Export JSON</a>
      <a class="ghost btn" href="/api/perf/export?format=csv" class:off={!exists} download>Export CSV</a>
    </div>
    {#if sessErr}<p class="err">device: {sessErr}</p>{/if}
    {#if last}
      <div class="tiles">
        <div class="tile"><span class="k">cpu</span><b>{last.cpuUser === null ? '—' : `${(last.cpuUser + (last.cpuSys || 0)).toFixed(1)}%`}</b></div>
        <div class="tile"><span class="k">memory</span><b>{last.memUsed === null ? '—' : `${(last.memUsed / MB).toFixed(0)} MB`}</b><span class="sub">of {last.memLimit === null ? '—' : (last.memLimit / MB).toFixed(0)}</span></div>
        <div class="tile"><span class="k">texture</span><b>{last.texUsed === null ? '—' : `${(last.texUsed / MB).toFixed(0)} MB`}</b><span class="sub">of {last.texMax === null ? '—' : (last.texMax / MB).toFixed(0)}</span></div>
        <div class="tile"><span class="k">bitmaps</span><b>{last.bitmaps ?? '—'}</b></div>
        <div class="tile"><span class="k">samples</span><b>{samples.length}</b><span class="sub">{fmtClock(last.t)}</span></div>
      </div>
    {/if}
  </div>

  {@render chart('channel cpu', cpuSeries, '%', null, '')}
  {@render chart('channel memory (MB)', memSeries, '', memLimit, 'limit')}
  {@render chart('texture memory (MB)', texSeries, '', texMax, 'max')}
  {@render chart('page faults / sample', faultSeries, '', null, '')}

  <div class="card">
    <div class="eyebrow">texture inventory <span class="tip2">every bitmap in texture memory, largest first</span></div>
    <div class="row">
      <button class="ghost" onclick={snapshotTextures}>Snapshot textures</button>
      {#if textures}<span class="meta">{textures.bitmapCount} bitmaps · {(textures.texture.used / MB).toFixed(0)} of {(textures.texture.max / MB).toFixed(0)} MB</span>{/if}
    </div>
    {#if texErr}<p class="err">{texErr}</p>{/if}
    {#if textures}
      <div class="tablewrap short">
        <table>
          <thead><tr><th class="l">bitmap</th><th>dimensions</th><th>memory</th></tr></thead>
          <tbody>
            {#each textures.bitmaps.slice(0, 40) as b}
              <tr>
                <td class="l file">{b.name || '(unnamed)'}</td>
                <td>{b.width}×{b.height}</td>
                <td>{(b.bytes / MB).toFixed(2)} MB{b.bytesEstimated ? ' *' : ''}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="note">* estimated as w×h×4 (RGBA) — this firmware doesn't report exact sizes.</p>
    {/if}
  </div>

  <div class="card">
    <div class="eyebrow">device console <span class="tip2">SceneGraph debug console, telnet :8080</span></div>
    <div class="row">
      {#each CONSOLE_CMDS as c}
        <button class="ghost sm2" disabled={conBusy} onclick={() => consoleRun(c)}>{c.replace(/_/g, ' ')}</button>
      {/each}
    </div>
    <p class="note">sgperf: start → drive the app → report (node ops + rendezvous per thread). logrendezvous prints to the :8085 console.</p>
    {#if conErr}<p class="err">{conErr}</p>{/if}
    {#if conStatus}<p class="note">{conStatus}</p>{/if}
    {#if conOut}<pre class="console">{conOut}</pre>{/if}
  </div>

  <div class="card bsprof">
    <div class="eyebrow">perfetto system trace <span class="tip2">threads, scheduling, heap graphs — Roku OS 15.2+, opens in ui.perfetto.dev</span></div>
    <div class="row">
      <button class="ghost" disabled={pfBusy} onclick={() => pfAct('enable')}>1. Enable for channel</button>
      {#if pf && pf.tracing}
        <button class="stop" disabled={pfBusy} onclick={() => pfAct('stop')}>■ Stop trace</button>
        <button class="ghost" disabled={pfBusy} onclick={() => pfAct('heap-snapshot')}>+ heap snapshot</button>
      {:else}
        <button class="go" disabled={pfBusy} onclick={() => pfAct('start')}>● 2. Start trace</button>
      {/if}
      {#if pf}
        <span class="meta">
          {pf.supported === false ? `firmware ${pf.firmware} < 15.2 — not supported` : ''}
          {pf.tracing ? `tracing → ${pf.file} (${(pf.bytes / MB).toFixed(1)} MB)` : ''}
          {pf.enabledChannels ? ` channels: ${pf.enabledChannels.join(', ') || 'none'}` : ''}
          {pf.brighttestRecord ? ` ${pf.brighttestRecord}` : ''}
        </span>
      {/if}
    </div>
    <p class="note">Enable must happen BEFORE the channel launches — enable, then relaunch the channel, then start the trace. Heap snapshots are written into the active trace.</p>
    {#if pfErr}<p class="err">{pfErr}</p>{/if}
    {#if pf && pf.files && pf.files.length}
      <div class="row">
        {#each pf.files.slice(0, 6) as f}
          <a class="ghost btn" href={'/api/perf/perfetto/download?file=' + encodeURIComponent(f.name)} download>{f.name} ({(f.bytes / MB).toFixed(1)} MB)</a>
        {/each}
      </div>
    {/if}
  </div>

  <div class="card bsprof">
    <div class="eyebrow">brightScript profiler (.bsprof) <span class="tip2">Roku's official profiler output — manifest bsprof_enable=1</span></div>
    <div class="row">
      <label class="ghost btn">Import .bsprof<input type="file" accept=".bsprof" onchange={importFile} hidden /></label>
      <button class="ghost" onclick={pullFromDevice} disabled={pulling}>{pulling ? 'Pulling…' : 'Pull from device :8090'}</button>
      {#if report}<span class="meta">{report.header.target} · {report.header.deviceModel} · fw {report.header.firmware} · {report.totals.functions} functions</span>{/if}
    </div>
    {#if bsprofErr}<p class="err">{bsprofErr}</p>{/if}
    {#if report}
      <div class="tablewrap">
        <table>
          <thead><tr>
            <th class="l">function</th><th class="l">file:line</th>
            {#each [['calls', 'calls'], ['cpuSelf', 'cpu self'], ['cpuSelfPct', 'cpu %'], ['cpuTotal', 'cpu total'], ['timeSelf', 'time self'], ['allocBytes', 'alloc']] as [k, label]}
              <th onclick={() => sortBy(k)} class:on={sortKey === k}>{label}{sortKey === k ? (sortAsc ? ' ↑' : ' ↓') : ''}</th>
            {/each}
          </tr></thead>
          <tbody>
            {#each rows as f}
              <tr>
                <td class="l fn">{f.func || '(anonymous)'}</td>
                <td class="l file">{f.file}{f.line ? `:${f.line}` : ''}</td>
                <td>{f.calls}</td>
                <td>{f.cpuSelf}</td>
                <td class="pcell"><span class="bar" style="width:{Math.min(100, f.cpuSelfPct)}%"></span>{pct(f.cpuSelfPct)}</td>
                <td>{f.cpuTotal}</td>
                <td>{f.timeSelf}</td>
                <td>{f.allocBytes ? kb(f.allocBytes) : '—'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="note">cpu/time are the profiler's raw ticks (Roku does not define the unit); percentages are against the whole run. Top 100 by {sortKey}.</p>
    {/if}
  </div>
</div>

<style>
  .profile { display: grid; gap: 14px; padding: 18px; grid-template-columns: 1fr 1fr; align-content: start; }
  .controls, .bsprof { grid-column: 1 / -1; }
  .card { background: var(--color-panel); border: 1px solid var(--color-line); border-radius: 14px; padding: 14px; min-width: 0; }
  .row { display: flex; gap: 10px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
  .spacer { flex: 1; }
  .tip2 { text-transform: none; letter-spacing: 0; color: #4c5266; margin-left: 8px; font-size: 10.5px; }

  button, .btn { background: var(--color-panel2); color: var(--color-text); border: 1px solid var(--color-line2); border-radius: 8px; padding: 6px 12px; font-size: 12px; cursor: pointer; text-decoration: none; }
  button:hover:not(:disabled), .btn:hover { border-color: var(--color-violet); }
  button:disabled, .btn.off { opacity: .45; pointer-events: none; }
  .go { background: rgba(124,108,255,.15); border-color: rgba(124,108,255,.4); color: #cfc9ff; }
  .stop { background: rgba(255,107,107,.12); border-color: rgba(255,107,107,.35); color: #ff9c9c; }
  .ivl { color: var(--color-haze); font-size: 12px; display: flex; gap: 6px; align-items: center; }
  select { background: #10131c; color: var(--color-text); border: 1px solid var(--color-line2); border-radius: 6px; padding: 3px 6px; }

  .tiles { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
  .tile { background: #10131c; border: 1px solid var(--color-line); border-radius: 10px; padding: 8px 14px; display: grid; }
  .tile .k { color: var(--color-haze); font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; }
  .tile b { font-size: 18px; font-weight: 600; }
  .tile .sub { color: var(--color-haze); font-size: 11px; }

  .charthead { display: flex; align-items: baseline; gap: 12px; }
  .legend { display: flex; gap: 10px; font-size: 11px; color: var(--color-haze); }
  .key { display: inline-flex; align-items: center; gap: 5px; }
  .key i { width: 10px; height: 3px; border-radius: 2px; display: inline-block; }
  .chart svg { width: 100%; height: auto; margin-top: 6px; display: block; }
  .grid { stroke: var(--color-line); stroke-width: 1; }
  .tick, .dlabel, .tip { font-size: 9px; font-family: var(--font-mono); }
  .tick { fill: var(--color-haze); }
  .dlabel { font-size: 10px; }
  .ref { stroke: var(--color-haze); stroke-dasharray: 5 4; stroke-width: 1; opacity: .7; }
  .mark { stroke: var(--color-amber); stroke-width: 1; opacity: .5; }
  .cross { stroke: var(--color-text); stroke-width: 1; opacity: .35; }
  .tipbg { fill: #0c0e14; stroke: var(--color-line2); }
  .tip { fill: var(--color-text); }
  .empty, .note { color: var(--color-haze); font-size: 12px; margin: 8px 0 0; }
  .err { color: #ff9c9c; font-size: 12px; margin: 8px 0 0; }
  .meta { color: var(--color-haze); font-size: 12px; }

  .tablewrap { overflow: auto; max-height: 420px; margin-top: 10px; }
  .tablewrap.short { max-height: 300px; }
  .sm2 { padding: 4px 9px; font-size: 11px; }
  .console {
    background: #0c0e14; border: 1px solid var(--color-line); border-radius: 8px; padding: 10px;
    font-family: var(--font-mono); font-size: 11px; color: var(--color-text); margin: 10px 0 0;
    max-height: 260px; overflow: auto; white-space: pre-wrap;
  }
  table { width: 100%; border-collapse: collapse; font-size: 12px; font-family: var(--font-mono); }
  th, td { text-align: right; padding: 4px 10px; white-space: nowrap; }
  th.l, td.l { text-align: left; }
  thead th { position: sticky; top: 0; background: var(--color-panel); color: var(--color-haze); font-weight: 500; cursor: pointer; border-bottom: 1px solid var(--color-line2); }
  thead th.on { color: var(--color-violet); }
  tbody tr { border-top: 1px solid var(--color-line); }
  tbody tr:hover { background: #171b28; }
  .fn { color: var(--color-text); }
  .file { color: var(--color-haze); max-width: 340px; overflow: hidden; text-overflow: ellipsis; }
  .pcell { position: relative; min-width: 90px; }
  .bar { position: absolute; left: 0; top: 15%; height: 70%; background: rgba(124,108,255,.18); border-radius: 2px; z-index: 0; }
  .pcell { z-index: 1; }
</style>
