<script>
  import { onMount } from 'svelte';
  import { api } from '../api.js';
  import { selectorFor } from '../steps.js';
  let { runSteps = [], running = false, currentFlow = null, runId = 0 } = $props();

  let history = $state([]);
  let selId = $state(null);
  let loaded = $state(null); // fetched detail for a past run
  let picked = $state(null); // scrubbed step index (null = follow latest)

  const isLive = $derived(selId === runId && runId > 0);
  const steps = $derived(isLive ? runSteps : (loaded?.steps ?? []));
  const flowName = $derived(isLive ? currentFlow : (loaded?.flow ?? ''));

  async function refresh() { try { history = await api.runs(); } catch {} }
  async function select(id) {
    selId = id; picked = null;
    loaded = id === runId ? null : await api.runDetail(id).catch(() => null);
  }

  // Initial load: history + select the live run, else the newest past run.
  onMount(async () => {
    await refresh();
    if (runId > 0) select(runId);
    else if (history.length) select(history[0].id);
  });
  // Follow a newly-started live run; refresh the list (and tallies) whenever a run ends.
  let lastRunId = 0;
  $effect(() => { if (runId !== lastRunId) { lastRunId = runId; if (runId > 0) { refresh(); select(runId); } } });
  $effect(() => { running; if (!running) refresh(); });

  const passed = $derived(steps.filter((s) => s.status === 'pass').length);
  const failed = $derived(steps.filter((s) => s.status === 'fail').length);
  const lastDone = $derived.by(() => { let i = -1; steps.forEach((s, k) => { if (s.status === 'pass' || s.status === 'fail') i = k; }); return i; });
  const cur = $derived(picked ?? (lastDone >= 0 ? lastDone : 0));
  const step = $derived(steps[cur] ?? null);

  const drawable = (n) => n.abs && n.abs.w > 0 && n.abs.h > 0 && n.visible !== false && (n.id || n.text || n.focusable || n.focused);
  const matches = (n, sel) => sel && (!sel.id || n.id === sel.id) && (!sel.text || n.text === sel.text) && (!sel.subtype || n.subtype === sel.subtype);
  const go = (d) => (picked = Math.min(steps.length - 1, Math.max(0, cur + d)));

  // Inspect a node within the currently-viewed step (the "time machine"). Reset when the step changes.
  let traceSel = $state(null);
  $effect(() => { cur; traceSel = null; });
  const selNode = $derived(step?.nodes?.find((n) => n.path === traceSel) ?? null);
  const copy = (t) => navigator.clipboard?.writeText(t).catch(() => {});

  function ago(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    return Math.round(s / 3600) + 'h ago';
  }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'ArrowLeft') go(-1); if (e.key === 'ArrowRight') go(1); }} />

<div class="page">
  <div class="phead">
    <h1>Runs</h1>
    {#if steps.length}<span class="tally"><b class="ok">{passed}</b> passed{#if failed} · <b class="bad">{failed}</b> failed{/if}{#if isLive && running} · running…{/if}</span>{/if}
    {#if flowName}<code class="file">{flowName}</code>{/if}
  </div>

  {#if !history.length && !steps.length}
    <div class="empty">No runs yet. Hit <b>Run</b> on a flow — each run's frames are captured so you can scrub back through it here.</div>
  {:else}
    <!-- run history -->
    <div class="runs">
      {#each history as r}
        <button class="run" class:sel={r.id === selId} class:live={r.id === runId && running} onclick={() => select(r.id)}>
          <span class="rdot" class:ok={r.ok === true} class:bad={r.ok === false}></span>
          <span class="rflow">{r.flow}</span>
          <span class="rmeta">{r.passed}/{r.total} · {ago(r.startedAt)}</span>
        </button>
      {/each}
    </div>

    <div class="trace">
      <div class="viewer">
        <div class="bezel">
          {#if step && step.frame}
            <img src={api.traceFrame(selId, cur)} alt={`step ${cur + 1}`} />
            {#if step.scene && step.nodes}
              <svg viewBox="0 0 {step.scene.w} {step.scene.h}" preserveAspectRatio="none">
                {#each step.nodes as n}
                  {#if drawable(n)}
                    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
                    <rect x={n.abs.x} y={n.abs.y} width={n.abs.w} height={n.abs.h}
                      class="box" class:hot={matches(n, step.selector)} class:sel={n.path === traceSel}
                      role="button" tabindex="-1" onclick={() => (traceSel = n.path)} />
                  {/if}
                {/each}
              </svg>
            {/if}
          {:else}
            <div class="noframe">{isLive && running ? 'capturing…' : 'no frame for this step'}</div>
          {/if}
        </div>
        <div class="scrubctl">
          <button onclick={() => go(-1)} disabled={cur <= 0} aria-label="previous">◀</button>
          <input type="range" min="0" max={Math.max(0, steps.length - 1)} value={cur} oninput={(e) => (picked = +e.currentTarget.value)} />
          <button onclick={() => go(1)} disabled={cur >= steps.length - 1} aria-label="next">▶</button>
          <span class="pos">{steps.length ? cur + 1 : 0}/{steps.length}</span>
        </div>
        {#if step}<div class="stepinfo {step.status}"><span class="op">{step.op}</span>{#if step.selector}<span class="sel">{JSON.stringify(step.selector)}</span>{/if}<span class="det">{step.detail}</span></div>{/if}

        {#if step && step.nodes}
          {#if selNode}
            <div class="nodedet">
              <div class="ndhead">
                <span class="sub">{selNode.subtype}</span>
                {#if selNode.id}<span class="id">#{selNode.id}</span>{/if}
                {#if selNode.text}<span class="txt">“{selNode.text}”</span>{/if}
                <code class="ndsel">{selectorFor(selNode)}</code>
                <button class="mini" onclick={() => copy(selectorFor(selNode))}>copy</button>
              </div>
              <dl class="fields">
                <div><dt>children</dt><dd>{selNode.childCount}</dd></div>
                {#each Object.entries(selNode.attrs ?? {}).filter(([k]) => k !== 'name') as [k, v]}
                  <div><dt>{k}</dt><dd>{v}</dd></div>
                {/each}
              </dl>
            </div>
          {:else}
            <p class="tap">Click a node on the frame to inspect it — at this step.</p>
          {/if}
        {/if}
      </div>

      <ol class="steps">
        {#each steps as s, i}
          <li class="{s.status}" class:cur={i === cur}>
            <button onclick={() => (picked = i)}><span class="n">{i + 1}</span><span class="cue"></span><span class="op">{s.op}</span></button>
          </li>
        {/each}
      </ol>
    </div>
  {/if}
</div>

<style>
  .page { padding: 22px 26px; height: 100%; box-sizing: border-box; display: flex; flex-direction: column; }
  .phead { display: flex; align-items: baseline; gap: 14px; flex: none; }
  h1 { font-family: var(--font-display); font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -.01em; }
  .tally { font-family: var(--font-mono); font-size: 12px; color: var(--color-haze); }
  .tally .ok { color: var(--color-pass); } .tally .bad { color: var(--color-fail); }
  .file { font-family: var(--font-mono); font-size: 12px; color: var(--color-haze); margin-left: auto; }
  .empty { padding: 22px; border: 1px dashed var(--color-line2); border-radius: 12px; color: var(--color-haze); margin-top: 18px; }

  .runs { display: flex; gap: 8px; overflow-x: auto; padding: 14px 0 4px; flex: none; }
  .run { display: flex; align-items: center; gap: 8px; flex: none; background: var(--color-panel); border: 1px solid var(--color-line); border-radius: 10px; padding: 8px 12px; cursor: pointer; }
  .run:hover { border-color: var(--color-line2); }
  .run.sel { border-color: var(--color-violet); background: rgba(124,108,255,.1); }
  .run.live { box-shadow: 0 0 0 1px rgba(255,93,108,.4); }
  .rdot { width: 8px; height: 8px; border-radius: 50%; background: var(--color-line2); flex: none; }
  .rdot.ok { background: var(--color-pass); } .rdot.bad { background: var(--color-fail); }
  .rflow { font-size: 13px; color: var(--color-text); }
  .rmeta { font-family: var(--font-mono); font-size: 11px; color: var(--color-haze); }

  .trace { display: grid; grid-template-columns: 1fr 240px; gap: 18px; margin-top: 14px; min-height: 0; flex: 1; }
  .viewer { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .bezel { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000; border: 1px solid var(--color-line2); border-radius: 12px; padding: 8px; }
  .bezel img { position: absolute; inset: 8px; width: calc(100% - 16px); height: calc(100% - 16px); object-fit: fill; border-radius: 5px; }
  .bezel svg { position: absolute; inset: 8px; width: calc(100% - 16px); height: calc(100% - 16px); }
  .box { fill: transparent; stroke: rgba(138,144,166,.22); stroke-width: 1; vector-effect: non-scaling-stroke; cursor: pointer; }
  .box:hover { fill: rgba(124,108,255,.14); stroke: var(--color-violet); stroke-width: 2; }
  .box.hot { fill: rgba(255,194,75,.16); stroke: var(--color-amber); stroke-width: 3; }
  .box.sel { fill: rgba(124,108,255,.2); stroke: var(--color-violet); stroke-width: 2.5; }
  .noframe { position: absolute; inset: 0; display: grid; place-items: center; color: var(--color-haze); font-family: var(--font-mono); font-size: 13px; }

  .scrubctl { display: flex; align-items: center; gap: 12px; }
  .scrubctl button { background: var(--color-panel2); color: var(--color-text); border: 1px solid var(--color-line2); border-radius: 8px; width: 34px; height: 30px; cursor: pointer; }
  .scrubctl button:disabled { opacity: .4; cursor: default; }
  .scrubctl input { flex: 1; accent-color: var(--color-violet); }
  .pos { font-family: var(--font-mono); font-size: 12px; color: var(--color-haze); min-width: 42px; text-align: right; }

  .stepinfo { display: flex; align-items: baseline; gap: 10px; font-family: var(--font-mono); font-size: 12px; padding: 8px 12px; border-radius: 8px; background: var(--color-panel); border: 1px solid var(--color-line); }
  .stepinfo .op { font-weight: 600; }
  .stepinfo.pass .op { color: var(--color-pass); }
  .stepinfo.fail { color: var(--color-fail); }
  .stepinfo .sel { color: #9aa2ff; }
  .stepinfo .det { color: var(--color-haze); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .tap { color: var(--color-haze); font-size: 12px; margin: 4px 2px 0; }
  .nodedet { border: 1px solid var(--color-line); border-radius: 10px; padding: 10px 12px; background: var(--color-panel); overflow: auto; }
  .ndhead { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .ndhead .sub { font-weight: 600; }
  .ndhead .id { font-family: var(--font-mono); color: var(--color-violet); font-size: 12px; }
  .ndhead .txt { color: var(--color-haze); }
  .ndsel { margin-left: auto; font-family: var(--font-mono); font-size: 11px; color: #b7c0ff; background: #10131c; border: 1px solid var(--color-line); border-radius: 6px; padding: 2px 7px; }
  .mini { background: var(--color-panel2); color: var(--color-text); border: 1px solid var(--color-line2); border-radius: 6px; padding: 3px 8px; cursor: pointer; font-size: 11px; }
  .mini:hover { border-color: var(--color-violet); }
  .fields { margin: 10px 0 0; display: grid; gap: 2px; }
  .fields > div { display: grid; grid-template-columns: 90px 1fr; gap: 10px; padding: 2px 0; border-top: 1px solid var(--color-line); font-family: var(--font-mono); font-size: 12px; }
  .fields dt { color: var(--color-haze); } .fields dd { margin: 0; color: var(--color-text); word-break: break-word; }

  .steps { list-style: none; margin: 0; padding: 0; overflow: auto; min-height: 0; }
  .steps li button { display: grid; grid-template-columns: 22px 12px auto; align-items: center; gap: 9px; width: 100%; text-align: left; background: transparent; border: none; cursor: pointer; color: var(--color-haze); font-family: var(--font-mono); font-size: 12px; padding: 5px 8px; border-radius: 7px; }
  .steps li button:hover { background: #171b28; }
  .steps li.cur button { background: rgba(124,108,255,.14); color: var(--color-text); }
  .steps .n { color: #4c5266; text-align: right; }
  .steps .cue { width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid var(--color-line2); justify-self: center; }
  .steps li.pass .cue { background: var(--color-pass); border-color: var(--color-pass); }
  .steps li.fail .cue { background: var(--color-fail); border-color: var(--color-fail); }
  .steps li.fail { color: var(--color-fail); }
</style>
