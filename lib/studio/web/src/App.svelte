<script>
  import { onMount } from 'svelte';
  import { api } from './lib/api.js';
  import { studio, selectedNode, commitLayout } from './lib/store.svelte.js';
  import LeaseTake from './lib/LeaseTake.svelte';
  import { heldText } from './lib/leasecta.js';
  import TileGrid from './lib/TileGrid.svelte';
  import { inspectRegistry } from './lib/tiles.js';
  import { setState, defaultLayout, preset } from './lib/layout.js';
  import Stage from './lib/Stage.svelte';
  import FeedPanel from './lib/FeedPanel.svelte';
  import { focusSig, settleStep } from './lib/feed.js';
  import { treeNeeded, treeIntervalMs, saveOverlay, shotNeeded, shotDecision, treeSignature, visiblePanels, monitorVisible } from './lib/treepolicy.js';
  import Inspector from './lib/Inspector.svelte';
  import Remote from './lib/Remote.svelte';
  import Editor from './lib/Editor.svelte';
  import FileTree from './lib/FileTree.svelte';
  import HierarchyTree from './lib/HierarchyTree.svelte';
  import SelectorPlayground from './lib/SelectorPlayground.svelte';
  import StateInspector from './lib/StateInspector.svelte';
  import ActionLog from './lib/ActionLog.svelte';
  import Network from './lib/Network.svelte';
  import ContextMenu from './lib/ContextMenu.svelte';
  import { panels as panelStore, isPoppedOut, popOut, dock } from './lib/panels.svelte.js';
  import Runs from './lib/pages/Runs.svelte';
  import Devices from './lib/pages/Devices.svelte';
  import Builds from './lib/pages/Builds.svelte';
  import { pageFromHash, hashToWrite } from './lib/route.js';
  import Record from './lib/pages/Record.svelte';
  import Settings from './lib/pages/Settings.svelte';
  import Profile from './lib/pages/Profile.svelte';
  import PromptModal from './lib/PromptModal.svelte';
  import { isSim, simText, simCls, simTail, simPollMs, mergeDevice, shouldPoll } from './lib/simbadge.js';

  const ic = {
    inspect: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="6"/><circle cx="10" cy="10" r="1.5" fill="currentColor" stroke="none"/><path d="M10 1v3M10 16v3M1 10h3M16 10h3"/></svg>',
    flows: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 6h14M3 10h14M3 14h9"/></svg>',
    builds: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10 2.5l7 3.5v8l-7 3.5-7-3.5V6z"/><path d="M3 6l7 3.5L17 6M10 9.5v8"/></svg>',
    runs: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="7.5"/><path d="M8 7l5 3-5 3z" fill="currentColor" stroke="none"/></svg>',
    record: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="7.5"/><circle cx="10" cy="10" r="3.5" fill="currentColor" stroke="none"/></svg>',
    devices: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="4" width="15" height="10" rx="1.5"/><path d="M7 17h6"/></svg>',
    profile: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 12h3l2.5-7 4 10 2.5-5H18"/></svg>',
    settings: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 6h12M4 10h12M4 14h12"/><circle cx="8" cy="6" r="1.6" fill="var(--color-panel)"/><circle cx="13" cy="10" r="1.6" fill="var(--color-panel)"/><circle cx="7" cy="14" r="1.6" fill="var(--color-panel)"/></svg>',
  };
  const PAGES = [
    { id: 'inspect', label: 'Inspect' },
    { id: 'runs', label: 'Runs' },
    { id: 'builds', label: 'Builds' },
    { id: 'record', label: 'Record' },
    { id: 'devices', label: 'Devices' },
    { id: 'profile', label: 'Profile' },
    { id: 'settings', label: 'Settings' },
  ];

  // Direct links: #/builds (any page id) opens that page; the hash follows the page after that.
  const startPage = pageFromHash(location.hash, PAGES.map((p) => p.id));
  if (startPage) studio.page = startPage;
  $effect(() => {
    const w = hashToWrite(studio.page, location.hash);
    if (w) location.hash = w;
  });
  const onHashChange = () => { const p = pageFromHash(location.hash, PAGES.map((x) => x.id)); if (p && p !== studio.page) studio.page = p; };

  let shotSrc = $state('');
  // A browser capture-card feed (FeedPanel). While one is live the screenshot loop is off; the tree loop keeps the overlay.
  let feed = $state(null);
  let calibrating = $state(false);
  let treeAt = $state(0);
  let settling = $state(false);
  let settleState = { settling: false, prev: null, pressAt: 0 };
  const feedSource = $derived(feed ? { kind: 'feed', stream: feed.stream, rect: feed.rect } : null);
  // After a press the boxes draw dimmed until two tree reads agree on the focused set.
  const markPress = () => { settleState = { settling: true, prev: null, pressAt: Date.now() }; settling = true; };
  let shotAt = $state(0);
  let flows = $state([]);
  let currentFlow = $state(null);
  let flowText = $state('');
  let flowMsg = $state('');
  let flowErr = $state(false);
  let runSteps = $state([]);
  let running = $state(false);
  let runId = $state(0);
  let treeOpen = $state(true);
  let editor;

  let treeBusy = false, shotBusy = false;
  // Screenshots on demand: dirtyAt is the newest press or tree change not yet covered by a shot.
  let dirtyAt = null, dirtySince = null, lastTreeSig = '';
  const markDirty = () => { dirtyAt = Date.now(); dirtySince ??= dirtyAt; };

  // Simulator target: Studio runs the app in the local engine, no device. Device-only panels say so.
  const sim = $derived(isSim(studio.device));

  // What is on screen decides what is polled: only open tiles count (a minimized or hidden tile is unmounted),
  // and the monitor tile gates screenshots and overlay tree reads on Inspect.
  const panels = $derived(visiblePanels(studio.layout));
  const monitorOpen = $derived(monitorVisible(studio.layout));
  const flowOpen = $derived(studio.layout.some((t) => t.id === 'flow' && t.state === 'open'));
  const monitorOn = $derived(studio.page === 'record' || monitorOpen);

  async function grabTree() {
    // The device answers one call at a time, so a tree read issued during a screenshot would only wait behind it.
    if (treeBusy || shotBusy || !treeNeeded({ overlay: studio.overlay, page: studio.page, visiblePanels: panels, monitor: monitorOpen, stateFallback: studio.stateFallback, live: studio.live, sim, lease: studio.lease })) return;
    treeBusy = true;
    try {
      const d = await api.tree();
      if (d.code === 'LOCKED') { studio.lease = d; studio.status = 'paused'; return; }
      if (d.error) { studio.status = d.error; return; }
      studio.scene = d.scene; studio.nodes = d.nodes; studio.appState = d.appState; studio.agent = d.agent || null; studio.status = `${d.nodes.length} nodes`;
      treeAt = Date.now();
      settleState = { ...settleState, ...settleStep(settleState, focusSig(d.nodes), treeAt) };
      if (settling !== settleState.settling) settling = settleState.settling;
      const sig = treeSignature(d.nodes); if (lastTreeSig && sig !== lastTreeSig) markDirty(); lastTreeSig = sig;
    } catch { studio.status = 'tree error'; } finally { treeBusy = false; }
  }
  async function grabShot() {
    if (shotBusy || feed || !shotNeeded({ page: studio.page, live: studio.live, sim, lease: studio.lease, monitor: monitorOpen })) return;
    shotBusy = true;
    const startedAt = Date.now();
    try {
      const r = await fetch(api.screenshotUrl());
      if (r.status === 423) { studio.lease = await r.json(); return; }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const prev = shotSrc; shotSrc = url;
      shotAt = Date.now();
      if (dirtyAt != null && dirtyAt <= startedAt) { dirtyAt = null; dirtySince = null; }
      if (prev.startsWith('blob:')) URL.revokeObjectURL(prev);
    } catch {} finally { shotBusy = false; }
  }
  // The shot scheduler: asks the policy whether a screenshot is due; the refresh button forces one.
  let lastShotTry = 0, wasShown = false;
  async function shotTick(forced = false) {
    // A monitor that just appeared (restored tile, Record page, Live turned on) gets a picture at once.
    const shown = !feed && shotNeeded({ page: studio.page, live: studio.live, sim, lease: studio.lease, monitor: monitorOpen });
    if (shown && !wasShown && !forced) markDirty();
    wasShown = shown;
    const d = shotDecision({ now: Date.now(), lastShotAt: Math.max(shotAt, lastShotTry), dirtyAt, dirtySince, forced });
    if (!d.take) return;
    lastShotTry = Date.now();
    await grabShot();
  }
  const refreshShot = () => shotTick(true);

  async function loadFlows() { try { flows = (await api.flows()).files; } catch {} }
  async function openFlow(rel) {
    setMsg('');
    if (!rel) { currentFlow = null; flowText = ''; return; }
    try { const { text } = await api.readFlow(rel); currentFlow = rel; flowText = text || ''; } catch { setMsg('could not open ' + rel, true); }
  }
  async function newFlow() {
    let name = await askText('New flow', 'new.e2e.yaml');
    if (!name) return;
    if (!/\.e2e\.ya?ml$/i.test(name)) name += '.e2e.yaml';
    currentFlow = name; flowText = 'appId: dev\nsteps:\n  - launch\n';
    if (!flows.some((f) => f.rel === name)) flows = [...flows, { name, rel: name }];
    setMsg('new — unsaved');
  }
  async function saveFlow() {
    if (!currentFlow) { setMsg('name a flow first (+)', true); return; }
    try {
      const j = await api.saveFlow(currentFlow, flowText);
      if (j.error) setMsg('save failed: ' + j.error, true);
      else { setMsg('saved ✓'); loadFlows(); }
    } catch (e) { setMsg('save failed: ' + e.message, true); }
  }
  function setMsg(m, err = false) { flowMsg = m; flowErr = err; }

  // The run stream is read with fetch (not EventSource) so a 409 RUN_IN_PROGRESS body can be shown.
  let runCtl = null, stopTimer = null;
  let stopping = $state(false);
  function endRun() { clearTimeout(stopTimer); stopTimer = null; runCtl = null; running = false; stopping = false; studio.runHighlight = null; }
  function onRunEvent(d) {
    if (d.type === 'start') { runId = d.runId; runSteps = d.steps.map((s) => ({ ...s, status: 'idle', detail: '', selector: null })); }
    else if (d.type === 'step') {
      runSteps = runSteps.map((s, i) => i === d.index
        ? { ...s, status: d.status, detail: d.detail || d.error || s.detail, selector: d.selector ?? s.selector, ...(d.scene !== undefined ? { scene: d.scene, nodes: d.nodes, appState: d.appState, frame: d.frame } : {}) }
        : s);
      if (d.status === 'running') studio.runHighlight = d.selector;
      else if (d.status === 'stopped') studio.runHighlight = null;
    } else if (d.type === 'stopped') {
      const st = runSteps[d.index];
      const hint = st && /may still/.test(st.detail || '') ? ' (the command may still have applied)' : '';
      setMsg(`run stopped at step ${d.index + 1}${st ? ' (' + st.op + ')' : ''}${hint}`, false);
    } else if (d.type === 'error') { setMsg('run error: ' + d.error, true); studio.runHighlight = null; }
    else if (d.type === 'aborted') { setMsg('run aborted: ' + (d.reason || 'the device lease was lost'), true); }
    else if (d.type === 'done') {
      if (!d.stopped && !d.aborted) setMsg(d.ok ? 'run passed ✓' : 'run failed ✗', !d.ok);
      endRun();
    }
  }
  async function run(rel = currentFlow) {
    if (!rel) { setMsg('save the flow first', true); return; }
    if (running) return;
    running = true; stopping = false; runSteps = [];
    const ctl = new AbortController(); runCtl = ctl;
    try {
      const r = await fetch(api.runUrl(rel), { signal: ctl.signal });
      if (r.status === 409) {
        const j = await r.json().catch(() => ({}));
        setMsg(j.code === 'RUN_IN_PROGRESS' ? 'a run is already in progress (another Studio tab?); stop it there first' : (j.error || 'run refused'), true);
        endRun(); return;
      }
      if (!r.ok || !r.body) { const j = await r.json().catch(() => ({})); setMsg('run error: ' + (j.error || 'HTTP ' + r.status), true); endRun(); return; }
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data:'));
          if (line) { try { onRunEvent(JSON.parse(line.slice(5).trim())); } catch {} }
        }
      }
    } catch {}
    if (runCtl === ctl) endRun();
  }
  // Stop: ask the server; if no `done` arrives within 5 s, close the stream (which stops the run server-side too).
  async function stopRun() {
    if (!running || stopping || !runId) return;
    stopping = true;
    stopTimer = setTimeout(() => { runCtl?.abort(); }, 5000);
    try { await api.stopRun(runId); } catch {}
  }
  function onWinKey(e) {
    if (e.defaultPrevented) return;
    if ((e.metaKey || e.ctrlKey) && e.key === '.' && running) { e.preventDefault(); stopRun(); }
    if (e.key === 'Escape' && tilesOpen) closeTiles();
  }

  function onRemote() { markDirty(); markPress(); setTimeout(grabTree, 90); }
  function addStep(line) { editor?.insert(line); setMsg('added — unsaved'); }

  function onInspectState(n) { studio.selectedPath = n.path; studio.nodeView = 'state'; studio.page = 'inspect'; showTile('node'); }
  // Tree rows ask for the Node tab through the store.
  const TAB_TILE = { net: 'network' };
  function showTile(id) {
    const t = studio.layout.find((o) => o.id === id);
    if (t && t.state !== 'open') commitLayout(setState(studio.layout, id, 'open', inspectRegistry));
  }
  $effect(() => { if (studio.openTab) { const id = TAB_TILE[studio.openTab] || studio.openTab; studio.openTab = null; showTile(id); } });

  // Tiles menu (header, Inspect only): show or hide each tile, restore minimized ones, presets and Reset.
  let tilesOpen = $state(false);
  let pending = $state(null); // 'default' | 'monitor-info' | 'reset': waiting for the inline confirmation
  const PRESET_LABEL = { default: 'Default', 'monitor-info': 'Monitor and info', reset: 'Reset layout' };
  function toggleTile(t, on) { commitLayout(setState(studio.layout, t.id, on ? 'open' : 'hidden', inspectRegistry)); }
  function applyPending() {
    const p = pending; closeTiles();
    commitLayout(p === 'monitor-info' ? preset('monitor-info', inspectRegistry) : defaultLayout(inspectRegistry));
  }
  function closeTiles() { tilesOpen = false; pending = null; }
  function onWinDown(e) { if (tilesOpen && !e.target.closest?.('.tilesmenu')) closeTiles(); }
  function onPopoutNode(n) { studio.selectedPath = n.path; popOut('node'); }
  let menu = $state(null); // node context menu { node, x, y }
  function onNodeContext(node, x, y) { menu = { node, x, y }; }

  // ── recorder (Record page): each remote press becomes a step, live ──
  let rec = $state({ active: false, steps: [] });
  let recMsg = $state('');
  const recText = $derived(serializeRec(rec.steps));
  function serializeRec(steps) {
    const out = ['appId: dev', 'steps:'];
    for (const s of steps) {
      if (s.op === 'launch') out.push('  - launch');
      else if (s.op === 'back') out.push('  - back');
      else if (s.op === 'home') out.push('  - home');
      else if (s.op === 'press') out.push(s.count > 1 ? `  - press: { key: ${s.key}, count: ${s.count} }` : `  - press: ${s.key}`);
      else if (s.op === 'line') out.push('  - ' + s.text);
    }
    return steps.length ? out.join('\n') + '\n' : '';
  }
  function recStart() { if (!rec.steps.length) rec.steps.push({ op: 'launch' }); rec.active = true; recMsg = ''; }
  function recStop() { rec.active = false; }
  function recClear() { rec.steps = []; rec.active = false; recMsg = ''; }
  function recPress(key) {
    if (rec.active) {
      if (key === 'Back') rec.steps.push({ op: 'back' });
      else if (key === 'Home') rec.steps.push({ op: 'home' });
      else {
        const last = rec.steps[rec.steps.length - 1];
        if (last && last.op === 'press' && last.key === key) last.count = (last.count || 1) + 1;
        else rec.steps.push({ op: 'press', key, count: 1 });
      }
    }
    markDirty(); markPress(); setTimeout(grabTree, 90);
  }
  function recLine(text) { if (!rec.active) recStart(); rec.steps.push({ op: 'line', text: text.replace(/^- /, '') }); }
  async function recSave() {
    const name = await askText('Save recording as', 'recorded.e2e.yaml');
    if (!name) return;
    const file = /\.e2e\.ya?ml$/i.test(name) ? name : name + '.e2e.yaml';
    const j = await api.saveFlow(file, recText);
    if (j.error) recMsg = 'save failed: ' + j.error;
    else { recMsg = 'saved ✓ ' + file; loadFlows(); }
  }

  // context-menu pick routes to the recorder on Record, else into the editor
  function onMenuPick(line) { if (studio.page === 'record') recLine(line); else addStep(line); }

  // ── custom text prompt (replaces window.prompt) ──
  let promptState = $state(null);
  function askText(title, initial = '', password = false) { return new Promise((resolve) => { promptState = { title, initial, password, resolve }; }); }
  function resolvePrompt(v) { const r = promptState?.resolve; promptState = null; r?.(v); }
  // Device lease: while another holder has the device, device polling pauses and a banner says who has it.
  // "Take over when free" queues Studio like any other waiter; it never preempts.
  async function leaseCheck() {
    if (sim) return;
    try {
      const l = await api.lease();
      studio.leaseInfo = l;
      if (l.holding) studio.everHeld = true;
      if (l.holding && (!studio.device?.connected || studio.device.host !== l.host)) refreshDevice(); // a pool member was just bound
      if (!studio.lease) return;
      if (l.holding) { studio.lease = null; studio.status = ''; return; }
      studio.lease = { ...studio.lease, lease: l };
    } catch {}
  }
  // The badge: who holds the device (or free), the queue length, and Studio's own state.
  const badge = (l) => {
    if (!l) return { cls: 'unknown', text: 'lease …', own: '' };
    const h = l.holder;
    const n = l.queue?.length || 0;
    const ps = l.pool && !l.holding ? l.poolState : null;
    const own = l.holding ? 'Studio holding' : l.queued ? 'Studio queued' : 'Studio released';
    const allBusy = ps && ps.busy >= ps.size;
    const who = allBusy ? `pool: all ${ps.size} busy` : h ? (h.mine ? 'held by Studio' : `held by ${h.agent}`) : l.queued ? 'waiting' : 'free';
    return { cls: l.holding ? 'mine' : h || allBusy ? 'other' : l.queued ? 'wait' : 'free', text: `${who}${n ? ` · ${n} queued` : ''}`, own };
  };
  // The "held for N" clock ticks once a second, only while the banner or the header control shows.
  let nowMs = $state(Date.now());
  const heldByOther = $derived(!!studio.lease || !!(studio.leaseInfo?.holder && !studio.leaseInfo.holder.mine && !studio.leaseInfo.holding));
  $effect(() => { if (!heldByOther) return; nowMs = Date.now(); const t = setInterval(() => { nowMs = Date.now(); }, 1000); return () => clearInterval(t); });
  async function refreshDevice() { studio.device = mergeDevice(studio.device, await api.device().catch(() => null)); }

  onMount(() => {
    loadFlows();
    let t1, t2;
    const treeLoop = async () => { await grabTree(); t1 = setTimeout(treeLoop, treeIntervalMs({ overlay: studio.overlay, monitor: monitorOn })); };
    const shotLoop = async () => { await shotTick(); t2 = setTimeout(shotLoop, 200); };
    const simLoop = async () => { if (shouldPoll(studio.device)) await refreshDevice(); t4 = setTimeout(simLoop, simPollMs(studio.device)); };
    const leaseLoop = async () => { await leaseCheck(); t3 = setTimeout(leaseLoop, 3000); };
    let t3, t4;
    // Turning the overlay on reads the tree at once instead of waiting for the next tick.
    let prevOverlay = studio.overlay;
    const overlayWatch = setInterval(() => { if (studio.overlay && !prevOverlay) grabTree(); prevOverlay = studio.overlay; }, 100);
    treeLoop(); shotLoop(); leaseLoop(); simLoop();
    return () => { clearInterval(overlayWatch); clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4); };
  });
</script>

<svelte:window onkeydown={onWinKey} onpointerdown={onWinDown} onhashchange={onHashChange} />

<div class="app" data-testid="studio-app">
  <header data-testid="studio-header" aria-label="Studio status">
    <div class="brand"><span class="dot"></span><b>brighttest</b><span class="sub">studio</span></div>
    <span class="device" data-testid="device-summary" role="status">{sim ? 'no device' : studio.device?.connected ? `${studio.device.model} · fw ${studio.device.firmware}` : studio.device ? 'no device' : 'connecting…'}</span>
    <div class="spacer"></div>
    {#if sim}
      <details class="leasebadge simbadge {simCls(studio.device)}" data-testid="sim-badge">
        <summary><span class="ldot"></span><span class="simtext" aria-live="polite">{simText(studio.device)}</span></summary>
        {#if simTail(studio.device).length}
          <pre class="simtail" data-testid="sim-tail" aria-label="engine output">{simTail(studio.device).join('\n')}</pre>
        {:else}
          <p class="simnote">The app runs in the local simulator; no device is used.</p>
        {/if}
      </details>
    {:else if studio.leaseInfo?.host || studio.leaseInfo?.pool}
      {@const b = badge(studio.leaseInfo)}
      <details class="leasebadge {b.cls}" class:alert={heldByOther} data-testid="lease-badge">
        <summary title="device lease: {b.text}; {b.own}" data-testid="lease-badge-summary" aria-label="device lease: {b.text}; {b.own}"><span class="ldot"></span>{b.text} · {b.own}</summary>
        {#if studio.leaseInfo.queue?.length}
          <ol class="lqueue" data-testid="lease-queue" aria-label="lease queue">
            {#each studio.leaseInfo.queue as q}<li><b>{q.agent}</b> {q.purpose ? `— ${q.purpose}` : ''}</li>{/each}
          </ol>
        {/if}
      </details>
      {#if heldByOther}<span class="hdrtake"><LeaseTake compact testid="lease-take-header" /></span>{/if}
    {/if}
    {#if !sim && (studio.page === 'inspect' || studio.page === 'record')}
      <FeedPanel bind:feed bind:calibrating />
    {/if}
    {#if studio.page === 'inspect' || studio.page === 'record'}
      <label class="tog" title="draw node outlines on the picture and click them to select; off shows only the device picture"><input type="checkbox" data-testid="toggle-overlay" aria-label="show node overlay" checked={studio.overlay} onchange={(e) => { studio.overlay = e.currentTarget.checked; saveOverlay(localStorage, studio.overlay); }} /> overlay</label>
    {/if}
    {#if studio.page === 'inspect'}
      <label class="tog" title="also outline structural containers with no id, text or focus"><input type="checkbox" data-testid="toggle-all-nodes" bind:checked={studio.showAll} disabled={!studio.overlay} /> all nodes</label>
      <label class="tog" title="also outline nodes the device isn't drawing — hidden, transparent, or scrolled out of view"><input type="checkbox" data-testid="toggle-offscreen" bind:checked={studio.showOffscreen} disabled={!studio.overlay} /> offscreen</label>
      <label class="tog"><input type="checkbox" data-testid="toggle-live" bind:checked={studio.live} /> live</label>
      {#if !sim}<span class="status" data-testid="live-status" role="status">{studio.status}</span>{/if}
      {#if running && !flowOpen}
        <button class="run stop chip" data-testid="header-run-stop" aria-label="Stop run" onclick={stopRun} disabled={stopping || !runId} title="Stop the run (Cmd/Ctrl+.)">{stopping ? 'Stopping…' : 'Running · Stop ■'}</button>
      {/if}
      <div class="tilesmenu">
        <button class="ghost" data-testid="tiles-menu" aria-haspopup="true" aria-expanded={tilesOpen} onclick={() => { tilesOpen = !tilesOpen; pending = null; }}>Tiles ▾</button>
        {#if tilesOpen}
          <div class="tileslist" data-testid="tiles-menu-list" role="group" aria-label="Tiles">
            {#each Object.keys(inspectRegistry.tiles) as id}
              {@const t = studio.layout.find((o) => o.id === id)}
              {#if t}
                <div class="titem">
                  <label><input type="checkbox" data-testid="tiles-menu-item-{id}" checked={t.state !== 'hidden'} onchange={(e) => toggleTile(t, e.currentTarget.checked)} /> {inspectRegistry.tiles[id].title}</label>
                  {#if t.state === 'min'}
                    <span class="minmark">minimized</span>
                    <button class="linkish" data-testid="tiles-restore-{id}" aria-label="Restore {inspectRegistry.tiles[id].title}" onclick={() => toggleTile(t, true)}>Restore</button>
                  {/if}
                </div>
              {/if}
            {/each}
            <hr />
            <div class="panelsec" data-testid="tiles-panels" role="group" aria-label="Inspector panels">
              <span class="minmark">Panels</span>
              {#each panelStore.order as id (id)}
                <div class="titem">
                  <span>{inspectRegistry.tiles[id].title}</span>
                  {#if isPoppedOut(id)}
                    <button class="linkish" data-testid="tiles-dock-{id}" aria-label="Dock {inspectRegistry.tiles[id].title}" onclick={() => dock(id)}>Dock</button>
                  {:else}
                    <button class="linkish" data-testid="tiles-popout-{id}" aria-label="Pop out {inspectRegistry.tiles[id].title}" onclick={() => popOut(id)}>Pop out</button>
                  {/if}
                </div>
              {/each}
            </div>
            <hr />
            {#if pending}
              <div class="confirm" role="alertdialog" aria-label="Confirm layout change">
                <span>Replace your layout with {PRESET_LABEL[pending]}? There is no undo.</span>
                <button class="linkish" data-testid="tiles-confirm" onclick={applyPending}>Replace</button>
                <button class="linkish" data-testid="tiles-cancel" onclick={() => (pending = null)}>Cancel</button>
              </div>
            {:else}
              <button class="linkish" data-testid="tiles-preset-default" onclick={() => (pending = 'default')}>Default</button>
              <button class="linkish" data-testid="tiles-preset-monitor-info" onclick={() => (pending = 'monitor-info')}>Monitor and info</button>
              <button class="linkish" data-testid="tiles-reset" onclick={() => (pending = 'reset')}>Reset layout</button>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </header>
  {#if studio.lease}
    <div class="leasebar" role="alert" data-testid="lease-bar">
      <span class="licon" aria-hidden="true">&#9888;</span>
      <span class="ltext" data-testid="lease-text"><span><b>{heldText(studio.lease, nowMs)}</b>{studio.lease.lease?.queue?.length ? ` · ${studio.lease.lease.queue.length} queued` : ''}</span><span class="lsub">The inspector, screenshots and runs are paused until Studio has the device. Taking it queues Studio and never interrupts the holder.</span></span>
      <LeaseTake autofocus />
    </div>
  {/if}

  <div class="body">
    <nav class="rail" data-testid="page-nav" aria-label="Studio pages">
      {#each PAGES as p}
        <button class:active={studio.page === p.id} data-testid="nav-{p.id}" aria-label={p.label} aria-current={studio.page === p.id ? 'page' : undefined} onclick={() => (studio.page = p.id)}>
          <span class="ico">{@html ic[p.id]}</span>
          <span class="lbl">{p.label}</span>
        </button>
      {/each}
    </nav>

    <main class="view">
      <!-- Inspect stays mounted (hidden when inactive) so the editor keeps its state -->
      <div class="inspect" data-testid="page-inspect" class:hidden={studio.page !== 'inspect'}>
        <div class="work">
          <TileGrid layout={studio.layout} registry={inspectRegistry} oncommit={commitLayout}>
            {#snippet content(id)}
              {#if id === 'flow'}
                <section class="editorcol" style="grid-template-columns: {treeOpen ? '196px 1fr' : '1fr'}">
                  {#if treeOpen}
                    <div class="card treecard" data-testid="flow-tree">
                      <FileTree {flows} current={currentFlow} onopen={openFlow} onnew={newFlow} ontoggle={() => (treeOpen = false)} />
                    </div>
                  {/if}
                  <div class="flow" data-testid="flow-editor" role="region" aria-label="Flow editor">
                    <div class="flowhead">
                      {#if !treeOpen}
                        <button class="ghost sm" onclick={() => (treeOpen = true)} title="show file tree" aria-label="show file tree" data-testid="flow-tree-show">›</button>
                      {/if}
                      <span class="fname" data-testid="flow-name">{currentFlow ?? 'no file open'}</span>
                    </div>
                    <div class="editorwrap" data-testid="flow-editor-text"><Editor bind:value={flowText} bind:this={editor} getSelected={selectedNode} onStop={stopRun} /></div>
                    <div class="flowbar">
                      <button class="ghost" data-testid="flow-save" aria-label="Save flow" onclick={saveFlow}>Save</button>
                      {#if running}
                        <button class="run stop" data-testid="flow-stop" aria-label="Stop run" onclick={stopRun} disabled={stopping || !runId} title="Stop the run (Cmd/Ctrl+.)">{stopping ? 'Stopping…' : 'Stop ■'}</button>
                      {:else}
                        <button class="run" data-testid="flow-run" aria-label="Run flow" onclick={() => run()} disabled={sim} title={sim ? 'needs a device; start Studio with --host' : ''}>Run ▶</button>
                      {/if}
                      <span class="msg" data-testid="flow-message" role="status" class:err={flowErr}>{flowMsg}</span>
                    </div>
                    {#if runSteps.length}
                      <ol class="transport" data-testid="flow-run-steps" aria-label="Run steps">
                        {#each runSteps as s}
                          <li class={s.status}><span class="cue"></span><span class="op">{s.op}</span><span class="det">{s.detail}</span></li>
                        {/each}
                      </ol>
                    {/if}
                  </div>
                </section>
              {:else if id === 'monitor'}
                <div class="feed" data-testid="live-monitor">
                  <div class="eyebrow">{#if studio.overlay}<span class="tip">right-click a node for actions</span>{:else}<span class="tip" data-testid="monitor-overlay-off">overlay off</span>{/if}</div>
                  {#if sim}
                    <div class="needsdev" data-testid="monitor-needs-device" role="note">Screen mirror needs a device. Start Studio with --host to use it.</div>
                  {:else}
                    <div class="stagebox"><Stage {shotSrc} {shotAt} onrefresh={refreshShot} source={feedSource} {treeAt} {settling} aid={calibrating} fit="contain" oncontext={onNodeContext} /></div>
                  {/if}
                </div>
              {:else if id === 'remote'}
                <div class="remotewrap" data-testid="remote-panel">
                  {#if sim}<div class="needsdev" data-testid="remote-needs-device" role="note">The remote needs a device.</div>{:else}<Remote onact={onRemote} />{/if}
                </div>
              {:else if id === 'node'}
                <Inspector onadd={addStep} />
              {:else if id === 'tree'}
                <HierarchyTree />
              {:else if id === 'selector'}
                <SelectorPlayground onadd={addStep} />
              {:else if id === 'actions'}
                <ActionLog />
              {:else if id === 'network'}
                <Network onadd={addStep} />
              {:else if id === 'state'}
                <StateInspector onadd={addStep} />
              {/if}
            {/snippet}
          </TileGrid>
        </div>
      </div>

      {#if studio.page === 'runs'}
        <Runs {runSteps} {running} {currentFlow} {runId} />
      {:else if studio.page === 'builds'}
        <Builds />
      {:else if studio.page === 'devices'}
        <Devices onconnected={refreshDevice} askPassword={(d) => askText(`Dev password for ${d.name} (${d.host})`, '', true)} />
      {:else if studio.page === 'record'}
        <Record {shotSrc} source={feedSource} {treeAt} {settling} aid={calibrating} active={rec.active} {recText} stepCount={rec.steps.length} msg={recMsg}
          onstart={recStart} onstop={recStop} onclear={recClear} onsave={recSave} onpress={recPress} oncontext={onNodeContext} />
      {:else if studio.page === 'profile'}
        <Profile />
      {:else if studio.page === 'settings'}
        <Settings />
      {/if}
    </main>
  </div>

  {#if menu}
    <ContextMenu node={menu.node} x={menu.x} y={menu.y} onpick={onMenuPick} onclose={() => (menu = null)} oninspect={onInspectState} onpopout={onPopoutNode} />
  {/if}

  {#if promptState}
    <PromptModal title={promptState.title} initial={promptState.initial} password={promptState.password}
      placeholder={promptState.password ? '' : 'name.e2e.yaml'}
      onsubmit={(v) => resolvePrompt(v || null)} oncancel={() => resolvePrompt(null)} />
  {/if}
</div>

<style>
  .app { height: 100%; display: flex; flex-direction: column; }
  header {
    display: flex; align-items: center; gap: 16px; padding: 10px 18px;
    border-bottom: 1px solid var(--color-line); background: linear-gradient(180deg, #171b28, #12141d);
  }
  .brand { display: flex; align-items: baseline; gap: 7px; }
  .brand b { font-weight: 700; letter-spacing: -.01em; }
  .brand .sub { color: var(--color-violet); font-weight: 500; }
  .brand .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--color-pass); box-shadow: 0 0 10px var(--color-pass); align-self: center; }
  .device { font-family: var(--font-mono); font-size: 12px; color: var(--color-haze); }
  .spacer { flex: 1; }
  .tog { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--color-haze); cursor: pointer; }
  .leasebar { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; padding: 10px 14px; font-size: 13px; color: var(--color-text);
    background: color-mix(in srgb, var(--color-amber) 16%, var(--color-panel)); border-bottom: 2px solid var(--color-amber); border-left: 6px solid var(--color-amber); }
  .leasebar .licon { font-size: 20px; color: var(--color-amber); }
  .leasebar .ltext { flex: 1 1 260px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .leasebar .lsub { font-size: 11px; color: var(--color-haze); }
  @media (max-width: 700px) { .hdrtake { display: none; } }
  .leasebadge.alert > summary { padding: 3px 8px; border: 1px solid var(--color-amber); border-radius: 6px; color: var(--color-amber); }
  .leasebadge { position: relative; font-size: 12px; }
  .leasebadge summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 6px; }
  .leasebadge summary::-webkit-details-marker { display: none; }
  .leasebadge.free .ldot { background: var(--color-line); outline: 1px solid var(--color-haze); }
  .leasebadge.wait .ldot { background: #d29922; }
  .leasebadge .ldot { width: 8px; height: 8px; border-radius: 50%; background: var(--color-haze); }
  .leasebadge.mine .ldot { background: #3fb950; }
  .leasebadge.other .ldot { background: #d29922; }
  .leasebadge .lqueue { position: absolute; right: 0; z-index: 5; margin: 4px 0 0; padding: 6px 10px 6px 26px; background: var(--color-panel); border: 1px solid var(--color-haze); white-space: nowrap; }
  .needsdev { padding: 16px; font-size: 12px; color: var(--color-haze); }
  .simtail, .simnote { position: absolute; right: 0; z-index: 5; margin: 4px 0 0; padding: 6px 10px; max-width: 60vw; max-height: 40vh; overflow: auto; background: var(--color-panel); border: 1px solid var(--color-haze); font-size: 11px; white-space: pre-wrap; }
  .status { font-family: var(--font-mono); font-size: 11px; color: var(--color-haze); min-width: 68px; text-align: right; }

  .body { flex: 1; display: flex; min-height: 0; }
  .rail { width: 84px; flex: none; display: flex; flex-direction: column; gap: 4px; padding: 12px 10px; border-right: 1px solid var(--color-line); background: #10131c; }
  .rail button {
    display: flex; flex-direction: column; align-items: center; gap: 5px; padding: 10px 4px;
    background: transparent; border: 1px solid transparent; border-radius: 12px; cursor: pointer;
    color: var(--color-haze); transition: color .12s, background .12s, border-color .12s;
  }
  .rail button:hover { color: var(--color-text); background: #171b28; }
  .rail button.active { color: var(--color-violet); background: rgba(124,108,255,.1); border-color: rgba(124,108,255,.35); }
  .rail .ico { width: 20px; height: 20px; display: block; }
  .rail .ico :global(svg) { width: 20px; height: 20px; }
  .rail .lbl { font-size: 10.5px; letter-spacing: .02em; }

  .view { flex: 1; min-width: 0; overflow: auto; }
  .hidden { display: none; }
  .inspect { height: 100%; }

  .work { padding: 18px; box-sizing: border-box; }
  .feed { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .stagebox { flex: 1; min-height: 0; }
  .remotewrap { display: flex; justify-content: center; }
  .remotewrap :global(.remote) { flex-wrap: wrap; justify-content: center; gap: 12px; }
  .editorcol { display: grid; gap: 14px; min-height: 0; height: 100%; }
  .card.treecard { min-height: 0; overflow: hidden; display: flex; }
  .tilesmenu { position: relative; }
  .tileslist { position: absolute; right: 0; top: 34px; z-index: 40; min-width: 220px; padding: 8px 10px; background: var(--color-panel2); border: 1px solid var(--color-line2);
    border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.5); display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
  .tileslist hr { border: none; border-top: 1px solid var(--color-line); margin: 4px 0; width: 100%; }
  .titem { display: flex; align-items: center; gap: 8px; }
  .titem label { flex: 1; cursor: pointer; }
  .panelsec { display: flex; flex-direction: column; gap: 2px; }
  .panelsec .titem span:first-child { flex: 1; }
  .minmark { color: var(--color-amber); font-size: 11px; }
  .linkish { background: transparent; border: none; color: var(--color-violet); cursor: pointer; font-size: 12px; text-align: left; padding: 2px 0; }
  .linkish:hover { text-decoration: underline; }
  .confirm { display: flex; flex-direction: column; gap: 4px; }
  .run.chip { padding: 4px 12px; font-size: 12px; }
  .sm { padding: 3px 9px; line-height: 1; }
  .fname { font-family: var(--font-mono); font-size: 12px; color: var(--color-haze); margin-left: auto; }
  .tip { text-transform: none; letter-spacing: 0; color: #4c5266; margin-left: 8px; font-size: 10.5px; }
  .card { background: var(--color-panel); border: 1px solid var(--color-line); border-radius: 14px; padding: 14px; }
  .flow { display: grid; grid-template-rows: auto 1fr auto auto; min-height: 0; height: 100%; }

  .eyebrow { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--color-haze); margin-bottom: 8px; }
  .flowhead { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .ghost { background: var(--color-panel2); color: var(--color-text); border: 1px solid var(--color-line2); border-radius: 8px; padding: 5px 12px; cursor: pointer; font-size: 12px; }
  .ghost:hover { border-color: var(--color-violet); }
  .editorwrap { min-height: 0; border: 1px solid var(--color-line); border-radius: 10px; overflow: hidden; background: #0d1016; }
  .flowbar { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
  .run { white-space: nowrap; background: var(--color-violet); color: #0c0e14; font-weight: 700; border: none; border-radius: 8px; padding: 7px 18px; cursor: pointer; }
  .run:hover:not(:disabled) { background: #8f80ff; }
  .run.stop { background: var(--color-fail); color: #fff; }
  .run.stop:hover:not(:disabled) { filter: brightness(1.12); }
  .run:disabled { opacity: .55; cursor: default; }
  .msg { font-family: var(--font-mono); font-size: 12px; color: var(--color-haze); }
  .msg.err { color: var(--color-fail); }

  .transport { list-style: none; margin: 12px 0 0; padding: 0; max-height: 22vh; overflow: auto; }
  .transport li { display: grid; grid-template-columns: 16px auto 1fr; align-items: center; gap: 9px; padding: 3px 0; font-family: var(--font-mono); font-size: 12px; color: var(--color-haze); }
  .transport .cue { width: 9px; height: 9px; border-radius: 50%; border: 1.5px solid var(--color-line2); justify-self: center; }
  .transport li.running .cue { border-color: var(--color-amber); background: var(--color-amber); box-shadow: 0 0 10px var(--color-amber); }
  .transport li.pass .cue { border-color: var(--color-pass); background: var(--color-pass); }
  .transport li.fail .cue { border-color: var(--color-fail); background: var(--color-fail); }
  .transport li.running .op { color: var(--color-amber); }
  .transport li.pass .op { color: var(--color-text); }
  .transport li.stopped .cue { border-color: var(--color-haze); background: var(--color-haze); border-radius: 2px; }
  .transport li.stopped .op, .transport li.stopped { color: var(--color-amber); }
  .transport li.fail { color: var(--color-fail); }
  .transport .det { color: var(--color-haze); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
