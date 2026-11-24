<script>
  import { onMount, onDestroy } from 'svelte';
  import { api } from './api.js';
  import { rowOf, travelOutcome } from './actionlog.js';

  // Action log and time travel (STA23-F2). Lists the app's state.action events (GET /api/state/actions) and, per entry,
  // a Travel button that POSTs the existing travel action. Travel restores the recorded state only; the server's note
  // says so and is shown as-is. An unknown entry (404) is shown as a message.
  let st = $state('connecting');  // connecting | live | locked | none | down
  let rows = $state([]);
  let msg = $state('');
  let err = $state(false);
  let busy = $state(null);
  let timer = null, alive = true;

  async function load() {
    try {
      const r = await api.stateActions();
      if (!alive) return;
      if (r.status === 423) st = 'locked';
      else if (r.status === 503) st = 'none';
      else if (r.ok) { st = 'live'; rows = (r.actions || []).map(rowOf); }
      else st = 'down';
    } catch { if (alive) st = 'down'; }
  }
  async function travel(entry) {
    busy = entry;
    try {
      const o = travelOutcome(await api.stateActionTravel(entry));
      msg = `entry ${entry}: ${o.text}`; err = o.bad;
    } catch { msg = `entry ${entry}: request failed`; err = true; }
    busy = null;
    load();
  }
  onMount(() => { load(); timer = setInterval(load, 2000); });
  onDestroy(() => { alive = false; clearInterval(timer); });
</script>

{#if st === 'none'}
  <p class="empty">No instrument hub is running in Studio, so there is no action log.</p>
{:else if st === 'locked'}
  <p class="empty err">Device is held by another session. Take the device in the header to use time travel.</p>
{:else if st === 'down'}
  <p class="empty err">Action log routes unreachable. Retrying.</p>
{:else if st === 'live' && !rows.length}
  <p class="empty">No actions recorded yet. The app reports them as <code>state.action</code> events.</p>
{/if}
{#if msg}<p class="msg" class:err role="status">{msg}</p>{/if}
{#if rows.length}
  <table class="log">
    <thead><tr><th>seq</th><th>type</th><th>hashBefore</th><th>hashAfter</th><th></th></tr></thead>
    <tbody>
      {#each rows as r (r.entry)}
        <tr>
          <td>{r.entry}</td><td>{r.type}</td>
          <td><code>{r.before}</code></td><td><code>{r.after}</code></td>
          <td><button disabled={busy === r.entry} title={r.snapshot ? 'restore the state recorded on this entry' : 'no snapshot recorded on this entry'} onclick={() => travel(r.entry)}>Travel</button></td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  .empty { color: var(--color-haze); font-size: 13px; margin: 6px 0; line-height: 1.5; }
  .empty code { font-family: var(--font-mono); color: var(--color-violet); font-size: 12px; }
  .empty.err, .msg.err { color: var(--color-amber); }
  .msg { font-size: 12px; margin: 4px 0; color: var(--color-haze); line-height: 1.4; }
  .log { width: 100%; border-collapse: collapse; font-family: var(--font-mono); font-size: 12px; }
  th { text-align: left; color: var(--color-violet); font-weight: normal; padding: 2px 6px; }
  td { padding: 3px 6px; border-top: 1px solid var(--color-line); }
  button { background: #10131c; border: 1px solid var(--color-line); border-radius: 6px; cursor: pointer; color: #b7c0ff; font-family: var(--font-mono); font-size: 12px; padding: 2px 8px; }
  button:hover { border-color: var(--color-violet); }
</style>
