<script>
  import Stage from '../Stage.svelte';
  import Remote from '../Remote.svelte';
  let { shotSrc, active, recText, stepCount, msg, onstart, onstop, onclear, onsave, onpress, oncontext } = $props();
  let pre;
  $effect(() => { recText; if (pre) pre.scrollTop = pre.scrollHeight; });
</script>

<div class="work">
  <section class="left">
    <div class="card feed">
      <div class="eyebrow">program monitor <span class="tip">right-click a node to record an assertion</span></div>
      <Stage {shotSrc} {oncontext} />
    </div>
    <div class="card remotecard">
      <div class="eyebrow">remote {#if active}<span class="rec">● REC</span>{/if}</div>
      <div class="remotewrap"><Remote onact={onpress} /></div>
    </div>
  </section>

  <section class="right">
    <div class="card recpanel">
      <div class="rhead">
        <div class="eyebrow">recording</div>
        <div class="ctl">
          {#if !active}
            <button class="primary" onclick={onstart}>● Record</button>
          {:else}
            <button class="stop" onclick={onstop}>■ Stop</button>
          {/if}
          <button class="ghost" onclick={onclear} disabled={!stepCount}>Clear</button>
          <button class="ghost" onclick={onsave} disabled={!stepCount}>Save…</button>
          <span class="msg">{msg}</span>
        </div>
      </div>
      <pre bind:this={pre} class="doc">{recText || '# Press ● Record, then drive the remote.\n# Each press is captured live below.'}</pre>
      <p class="hint">Every remote press is captured live — repeats coalesce into a count. Right-click a node on the monitor to record an assertion built from its real values.</p>
    </div>
  </section>
</div>

<style>
  .work { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; padding: 18px; height: 100%; box-sizing: border-box; }
  .left { display: grid; grid-template-rows: 1fr auto; gap: 18px; min-height: 0; }
  .right { min-height: 0; }
  .card { background: var(--color-panel); border: 1px solid var(--color-line); border-radius: 14px; padding: 14px; }
  .card.feed { display: flex; flex-direction: column; gap: 12px; min-height: 0; overflow: auto; }
  .card.remotecard { display: flex; flex-direction: column; gap: 10px; }
  .remotewrap { display: flex; justify-content: center; }
  .recpanel { height: 100%; display: grid; grid-template-rows: auto 1fr auto; min-height: 0; }

  .eyebrow { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--color-haze); }
  .tip { text-transform: none; letter-spacing: 0; color: #4c5266; margin-left: 8px; font-size: 10.5px; }
  .rec { color: var(--color-fail); margin-left: 8px; letter-spacing: .12em; animation: blink 1.1s steps(2,end) infinite; }
  @keyframes blink { 50% { opacity: .35; } }

  .rhead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .ctl { display: flex; align-items: center; gap: 8px; }
  .primary { background: var(--color-fail); color: #0c0e14; font-weight: 700; border: none; border-radius: 8px; padding: 6px 14px; cursor: pointer; }
  .primary:hover { filter: brightness(1.08); }
  .stop { background: var(--color-panel2); color: var(--color-text); border: 1px solid var(--color-fail); border-radius: 8px; padding: 6px 14px; cursor: pointer; }
  .ghost { background: var(--color-panel2); color: var(--color-text); border: 1px solid var(--color-line2); border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 12px; }
  .ghost:hover:not(:disabled) { border-color: var(--color-violet); }
  .ghost:disabled { opacity: .45; cursor: default; }
  .msg { font-family: var(--font-mono); font-size: 12px; color: var(--color-pass); }

  .doc {
    margin: 0; min-height: 0; overflow: auto; background: #0d1016; border: 1px solid var(--color-line);
    border-radius: 10px; padding: 12px 14px; font-family: var(--font-mono); font-size: 12.5px; line-height: 1.7;
    color: #dfe4ee; white-space: pre; tab-size: 2;
  }
  .doc:empty::before { content: ''; }
  .hint { color: var(--color-haze); font-size: 12px; margin: 10px 0 0; }
</style>
