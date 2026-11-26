<script>
  import { textClass, bgClass, runOutcome, fmtDur, clean } from './leaseRoles.js';
  let { board = null, error = '' } = $props();

  const devices = $derived(board?.devices || []);
  const pools = $derived(board?.pools || []);

  const stateRole = (s) => (s === 'held' || s === 'free' || s === 'stale' || s === 'corrupt' ? s : 'unknown');
  const reachText = (r) => (r?.state === 'up' ? 'reachable' : r?.state === 'unreachable' ? 'unreachable' : r?.idle ? 'idle, not probed' : 'reach unknown');

  // Bar strip: one bar per run, oldest left. Height by hold (scaled to the longest), the wait part on top in amber.
  const W = 360, H = 56;
  function bars(runs) {
    const rs = [...(runs || [])].reverse();
    if (!rs.length) return [];
    const holdOf = (r) => (Number.isFinite(r.heldMs) ? r.heldMs : 0);
    const waitOf = (r) => (Number.isFinite(r.waitedMs) ? r.waitedMs : 0);
    const max = Math.max(1, ...rs.map((r) => holdOf(r) + waitOf(r)));
    const bw = Math.min(28, W / rs.length - 3);
    return rs.map((r, i) => {
      const hh = Math.max(2, (holdOf(r) / max) * (H - 2));
      const wh = (waitOf(r) / max) * (H - 2);
      const x = i * (W / rs.length) + 1;
      return { x, w: Math.max(2, bw), hh, wh, y: H - hh, wy: H - hh - wh, role: runOutcome(r).role, tip: `${clean(r.agent) || '?'}: held ${fmtDur(r.heldMs)}, waited ${fmtDur(r.waitedMs)}` };
    });
  }
</script>

<section class="lease" data-testid="lease-board" aria-label="Lease">
  <div class="eyebrow">lease</div>
  {#if error}<p class="msg">{error}</p>{/if}
  {#if !board && !error}<p class="hint">Loading the lease board…</p>{/if}
  {#if board && !devices.length}<p class="hint">No devices in the lease directory yet. {board.hidden?.keys ? `${board.hidden.keys} hidden (loopback or idle).` : ''}</p>{/if}

  {#each devices as d (d.id)}
    <article class="card" data-testid="lease-device">
      <header>
        <span class="sdot {bgClass(stateRole(d.state))}"></span>
        <span class="label">{clean(d.label)}</span>
        <span class="state {textClass(stateRole(d.state))}">{d.state}</span>
        <span class="reach {textClass(d.reach?.state || 'unknown')}">{reachText(d.reach)}</span>
      </header>

      {#if d.holder}
        <div class="holder">
          <span class={textClass('held')}>{clean(d.holder.agent) || 'unknown'}</span>
          <span class={textClass('meta')}>{clean(d.holder.purpose)} · held {fmtDur(d.holder.heldMs)}{d.holder.foreign ? ` · on ${clean(d.holder.hostname)}` : ''}</span>
          {#if d.holder.staleReason}<div class={textClass('stale')}>stale: {clean(d.holder.staleReason)}</div>{/if}
        </div>
      {/if}
      {#if d.error}<div class="holder {textClass('corrupt')}">{clean(d.error)}</div>{/if}

      {#if d.queue?.length}
        <div class="line {textClass('queued')}">
          line: {d.queue.map((q) => `${q.dead ? 'x' : q.pos + '.'} ${clean(q.agent) || '?'} ${fmtDur(q.waitingMs)}`).join(' · ')}
        </div>
      {/if}

      {#if d.runs?.length}
        <svg class="strip" viewBox="0 0 {W} {H}" role="img" aria-label="Hold time of recent runs">
          {#each bars(d.runs) as b}
            <rect x={b.x} y={b.y} width={b.w} height={b.hh} rx="1.5" class={textClass(b.role)} fill="currentColor"><title>{b.tip}</title></rect>
            {#if b.wh > 0}<rect x={b.x} y={b.wy} width={b.w} height={b.wh} rx="1.5" class={textClass('waitBar')} fill="currentColor" opacity=".75" />{/if}
          {/each}
        </svg>
        <table>
          <thead><tr><th>start</th><th>agent</th><th>purpose</th><th>waited</th><th>held</th><th>end</th></tr></thead>
          <tbody>
            {#each d.runs as r}
              {@const o = runOutcome(r)}
              <tr>
                <td>{(r.startedAt || '').slice(11, 19)}</td><td>{clean(r.agent) || '?'}</td><td class="purpose">{clean(r.purpose)}</td>
                <td>{fmtDur(r.waitedMs)}</td><td>{r.ended === 'timeout' ? '-' : fmtDur(r.heldMs)}</td><td class={textClass(o.role)}>{o.text}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}

      {#if d.stats}
        <div class="stats {textClass('meta')}">
          {d.stats.window}: {d.stats.runs} {d.stats.runs === 1 ? 'run' : 'runs'} · median hold {fmtDur(d.stats.medianHoldMs)} · p90 {fmtDur(d.stats.p90HoldMs)} · median wait {fmtDur(d.stats.medianWaitMs)} · longest line {d.stats.maxQueue} · {d.stats.timeouts} gave up
        </div>
      {/if}
    </article>
  {/each}

  {#each pools as p}
    <div class="line {textClass('queued')}">pool gate: {p.queueLength} waiting{p.size ? ` (pool of ${p.size})` : ''}</div>
  {/each}
</section>

<style>
  .lease { margin-top: 22px; }
  .eyebrow { font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--color-haze); margin-bottom: 8px; }
  .card { border: 1px solid var(--color-line); border-radius: 12px; background: var(--color-panel); padding: 14px 16px; margin-bottom: 12px; }
  header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .sdot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .label { font-weight: 600; }
  .state, .reach { font-family: var(--font-mono); font-size: 12px; }
  .reach { margin-left: auto; }
  .holder { font-family: var(--font-mono); font-size: 12px; margin-top: 8px; display: flex; gap: 10px; flex-wrap: wrap; }
  .line { font-family: var(--font-mono); font-size: 12px; margin-top: 6px; overflow-wrap: anywhere; }
  .strip { width: 100%; max-width: 420px; height: 56px; margin-top: 10px; display: block; color: inherit; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-family: var(--font-mono); font-size: 11px; display: block; overflow-x: auto; }
  th { text-align: left; color: var(--color-haze); font-weight: 400; padding: 2px 10px 2px 0; white-space: nowrap; }
  td { padding: 2px 10px 2px 0; white-space: nowrap; }
  .purpose { max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
  .stats { font-family: var(--font-mono); font-size: 11px; margin-top: 10px; }
  .hint, .msg { font-size: 12px; color: var(--color-haze); }
  .msg { color: var(--color-fail); }
</style>
