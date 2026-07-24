<script>
  import { onMount } from 'svelte';
  import { api } from './lib/api.js';
  import { studio, selectedNode } from './lib/store.svelte.js';
  import Stage from './lib/Stage.svelte';
  import Inspector from './lib/Inspector.svelte';
  import Remote from './lib/Remote.svelte';
  import Editor from './lib/Editor.svelte';
  import FileTree from './lib/FileTree.svelte';
  import HierarchyTree from './lib/HierarchyTree.svelte';
  import SelectorPlayground from './lib/SelectorPlayground.svelte';
  import ContextMenu from './lib/ContextMenu.svelte';
  import Runs from './lib/pages/Runs.svelte';
  import Devices from './lib/pages/Devices.svelte';
  import Record from './lib/pages/Record.svelte';
  import Placeholder from './lib/pages/Placeholder.svelte';
  import PromptModal from './lib/PromptModal.svelte';

  const ic = {
    inspect: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="6"/><circle cx="10" cy="10" r="1.5" fill="currentColor" stroke="none"/><path d="M10 1v3M10 16v3M1 10h3M16 10h3"/></svg>',
    flows: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 6h14M3 10h14M3 14h9"/></svg>',
    runs: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="7.5"/><path d="M8 7l5 3-5 3z" fill="currentColor" stroke="none"/></svg>',
    record: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="7.5"/><circle cx="10" cy="10" r="3.5" fill="currentColor" stroke="none"/></svg>',
    devices: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="4" width="15" height="10" rx="1.5"/><path d="M7 17h6"/></svg>',
    settings: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 6h12M4 10h12M4 14h12"/><circle cx="8" cy="6" r="1.6" fill="var(--color-panel)"/><circle cx="13" cy="10" r="1.6" fill="var(--color-panel)"/><circle cx="7" cy="14" r="1.6" fill="var(--color-panel)"/></svg>',
  };
  const PAGES = [
    { id: 'inspect', label: 'Inspect' },
    { id: 'runs', label: 'Runs' },
    { id: 'record', label: 'Record' },
    { id: 'devices', label: 'Devices' },
    { id: 'settings', label: 'Settings' },
  ];

  let shotSrc = $state('');
  let flows = $state([]);
  let currentFlow = $state(null);
  let flowText = $state('');
  let flowMsg = $state('');
  let flowErr = $state(false);
  let runSteps = $state([]);
  let running = $state(false);
  let runId = $state(0);
  let treeOpen = $state(true);
  let tab = $state('node');
  let editor;

  let treeBusy = false, shotBusy = false;

  async function grabTree() {
    if (treeBusy || !studio.live || (studio.page !== 'inspect' && studio.page !== 'record')) return;
    treeBusy = true;
    try {
      const d = await api.tree();
      if (d.error) { studio.status = d.error; return; }
      studio.scene = d.scene; studio.nodes = d.nodes; studio.status = `${d.nodes.length} nodes`;
    } catch { studio.status = 'tree error'; } finally { treeBusy = false; }
  }
  async function grabShot() {
    if (shotBusy || !studio.live || (studio.page !== 'inspect' && studio.page !== 'record')) return;
    shotBusy = true;
    try {
      const blob = await (await fetch(api.screenshotUrl())).blob();
      const url = URL.createObjectURL(blob);
      const prev = shotSrc; shotSrc = url;
      if (prev.startsWith('blob:')) URL.revokeObjectURL(prev);
    } catch {} finally { shotBusy = false; }
  }

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

  function run(rel = currentFlow) {
    if (!rel) { setMsg('save the flow first', true); return; }
    running = true; runSteps = [];
    const es = new EventSource(api.runUrl(rel));
    es.onmessage = (ev) => {
      const d = JSON.parse(ev.data);
      if (d.type === 'start') { runId = d.runId; runSteps = d.steps.map((s) => ({ ...s, status: 'idle', detail: '', selector: null })); }
      else if (d.type === 'step') {
        runSteps = runSteps.map((s, i) => i === d.index
          ? { ...s, status: d.status, detail: d.detail || d.error || s.detail, selector: d.selector ?? s.selector, ...(d.scene !== undefined ? { scene: d.scene, nodes: d.nodes, frame: d.frame } : {}) }
          : s);
        if (d.status === 'running') studio.runHighlight = d.selector;
      } else if (d.type === 'error') { setMsg('run error: ' + d.error, true); studio.runHighlight = null; es.close(); running = false; }
      else if (d.type === 'done') { setMsg(d.ok ? 'run passed ✓' : 'run failed ✗', !d.ok); studio.runHighlight = null; es.close(); running = false; }
    };
    es.onerror = () => { es.close(); running = false; studio.runHighlight = null; };
  }

  function onRemote() { setTimeout(grabTree, 90); setTimeout(grabShot, 280); }
  function addStep(line) { editor?.insert(line); setMsg('added — unsaved'); }

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
    setTimeout(grabTree, 90); setTimeout(grabShot, 280);
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
  async function refreshDevice() { studio.device = await api.device().catch(() => ({ connected: false })); }

  onMount(() => {
    api.device().then((d) => (studio.device = d)).catch(() => {});
    loadFlows();
    let t1, t2;
    const treeLoop = async () => { await grabTree(); t1 = setTimeout(treeLoop, 300); };
    const shotLoop = async () => { await grabShot(); t2 = setTimeout(shotLoop, 900); };
    treeLoop(); shotLoop();
    return () => { clearTimeout(t1); clearTimeout(t2); };
  });
</script>

<div class="app">
  <header>
    <div class="brand"><span class="dot"></span><b>brighttest</b><span class="sub">studio</span></div>
    <span class="device">{studio.device?.connected ? `${studio.device.model} · fw ${studio.device.firmware}` : studio.device ? 'no device' : 'connecting…'}</span>
    <div class="spacer"></div>
    {#if studio.page === 'inspect'}
      <label class="tog"><input type="checkbox" bind:checked={studio.showAll} /> all nodes</label>
      <label class="tog"><input type="checkbox" bind:checked={studio.live} /> live</label>
      <span class="status">{studio.status}</span>
    {/if}
  </header>

  <div class="body">
    <nav class="rail">
      {#each PAGES as p}
        <button class:active={studio.page === p.id} onclick={() => (studio.page = p.id)}>
          <span class="ico">{@html ic[p.id]}</span>
          <span class="lbl">{p.label}</span>
        </button>
      {/each}
    </nav>

    <main class="view">
      <!-- Inspect stays mounted (hidden when inactive) so the editor keeps its state -->
      <div class="inspect" class:hidden={studio.page !== 'inspect'}>
        <div class="work">
          <section class="editorcol" style="grid-template-columns: {treeOpen ? '196px 1fr' : '1fr'}">
            {#if treeOpen}
              <div class="card treecard">
                <FileTree {flows} current={currentFlow} onopen={openFlow} onnew={newFlow} ontoggle={() => (treeOpen = false)} />
              </div>
            {/if}
            <div class="card flow">
              <div class="flowhead">
                {#if !treeOpen}
                  <button class="ghost sm" onclick={() => (treeOpen = true)} title="show file tree" aria-label="show file tree">›</button>
                {/if}
                <div class="eyebrow">flow</div>
                <span class="fname">{currentFlow ?? 'no file open'}</span>
              </div>
              <div class="editorwrap"><Editor bind:value={flowText} bind:this={editor} getSelected={selectedNode} /></div>
              <div class="flowbar">
                <button class="ghost" onclick={saveFlow}>Save</button>
                <button class="run" onclick={() => run()} disabled={running}>{running ? 'Running…' : 'Run ▶'}</button>
                <span class="msg" class:err={flowErr}>{flowMsg}</span>
              </div>
              {#if runSteps.length}
                <ol class="transport">
                  {#each runSteps as s}
                    <li class={s.status}><span class="cue"></span><span class="op">{s.op}</span><span class="det">{s.detail}</span></li>
                  {/each}
                </ol>
              {/if}
            </div>
          </section>

          <section class="sim">
            <div class="card feed">
              <div class="eyebrow">program monitor <span class="tip">right-click a node for actions</span></div>
              <Stage {shotSrc} oncontext={onNodeContext} />
            </div>
            <div class="card panel">
              <div class="tabs">
                <button class:on={tab === 'node'} onclick={() => (tab = 'node')}>Node</button>
                <button class:on={tab === 'tree'} onclick={() => (tab = 'tree')}>Tree</button>
                <button class:on={tab === 'selector'} onclick={() => (tab = 'selector')}>Selector</button>
              </div>
              <div class="panelbody">
                {#if tab === 'node'}
                  <Inspector onadd={addStep} />
                {:else if tab === 'tree'}
                  <HierarchyTree />
                {:else}
                  <SelectorPlayground onadd={addStep} />
                {/if}
              </div>
            </div>
            <div class="card remotecard">
              <div class="eyebrow">remote</div>
              <div class="remotewrap"><Remote onact={onRemote} /></div>
            </div>
          </section>
        </div>
      </div>

      {#if studio.page === 'runs'}
        <Runs {runSteps} {running} {currentFlow} {runId} />
      {:else if studio.page === 'devices'}
        <Devices onconnected={refreshDevice} askPassword={(d) => askText(`Dev password for ${d.name} (${d.host})`, '', true)} />
      {:else if studio.page === 'record'}
        <Record {shotSrc} active={rec.active} {recText} stepCount={rec.steps.length} msg={recMsg}
          onstart={recStart} onstop={recStop} onclear={recClear} onsave={recSave} onpress={recPress} oncontext={onNodeContext} />
      {:else if studio.page === 'settings'}
        <Placeholder title="Settings" blurb="Studio and project configuration." planned={['Edit brighttest.json (flows dir, source globs)', 'Default device host / password', 'Screenshot cadence and overlay preferences']} />
      {/if}
    </main>
  </div>

  {#if menu}
    <ContextMenu node={menu.node} x={menu.x} y={menu.y} onpick={onMenuPick} onclose={() => (menu = null)} />
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

  .work { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; padding: 18px; height: 100%; box-sizing: border-box; }
  .sim { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; gap: 18px; min-height: 0; }
  .card.feed { display: flex; flex-direction: column; gap: 12px; }
  .card.panel { display: grid; grid-template-rows: auto 1fr; min-height: 0; }
  .tabs { display: flex; gap: 4px; margin-bottom: 12px; }
  .tabs button { background: transparent; border: 1px solid transparent; color: var(--color-haze); border-radius: 8px; padding: 5px 13px; cursor: pointer; font-size: 12px; }
  .tabs button:hover { color: var(--color-text); }
  .tabs button.on { color: var(--color-violet); background: rgba(124,108,255,.12); border-color: rgba(124,108,255,.3); }
  .panelbody { min-height: 0; overflow: auto; }
  .card.remotecard { display: flex; flex-direction: column; gap: 10px; }
  .remotewrap { display: flex; justify-content: center; }
  .editorcol { display: grid; gap: 14px; min-height: 0; }
  .card.treecard { min-height: 0; overflow: hidden; display: flex; }
  .sm { padding: 3px 9px; line-height: 1; }
  .fname { font-family: var(--font-mono); font-size: 12px; color: var(--color-haze); margin-left: auto; }
  .tip { text-transform: none; letter-spacing: 0; color: #4c5266; margin-left: 8px; font-size: 10.5px; }
  .card { background: var(--color-panel); border: 1px solid var(--color-line); border-radius: 14px; padding: 14px; }
  .card.flow { display: grid; grid-template-rows: auto 1fr auto auto; min-height: 0; height: 100%; }

  .eyebrow { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--color-haze); margin-bottom: 8px; }
  .flowhead { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .ghost { background: var(--color-panel2); color: var(--color-text); border: 1px solid var(--color-line2); border-radius: 8px; padding: 5px 12px; cursor: pointer; font-size: 12px; }
  .ghost:hover { border-color: var(--color-violet); }
  .editorwrap { min-height: 0; border: 1px solid var(--color-line); border-radius: 10px; overflow: hidden; background: #0d1016; }
  .flowbar { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
  .run { background: var(--color-violet); color: #0c0e14; font-weight: 700; border: none; border-radius: 8px; padding: 7px 18px; cursor: pointer; }
  .run:hover:not(:disabled) { background: #8f80ff; }
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
  .transport li.fail { color: var(--color-fail); }
  .transport .det { color: var(--color-haze); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
