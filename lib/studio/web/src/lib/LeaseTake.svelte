<script>
  import { studio } from './store.svelte.js';
  import { api } from './api.js';
  import { ctaLabel, queuedText } from './leasecta.js';

  // The one "Take the device back" button (single handler, see leasecta.js). Used in the banner, the header and the
  // held notices. While Studio is queued it shows "Waiting, you are #N" with a spinner and is disabled: it never preempts.
  let { compact = false, autofocus = false, testid = 'lease-take-over' } = $props();
  // Queue Studio for the device like any other waiter (POST /api/lease acquire). One handler for every button.
  async function takeDevice() {
    try {
      const l = await api.leaseAction('acquire');
      studio.leaseInfo = l;
      studio.lease = l.holding ? null : { ...studio.lease, lease: l };
    } catch { /* the next lease poll shows the state */ }
  }
  let el = $state(null);
  const queued = $derived(!!(studio.leaseInfo?.queued || studio.lease?.lease?.queued));
  $effect(() => { if (autofocus && el) el.focus(); });
</script>

<button bind:this={el} class="take" class:compact class:queued data-testid={testid} disabled={queued} aria-busy={queued} onclick={takeDevice}>
  {#if queued}<span class="spin" aria-hidden="true"></span><span data-testid="lease-queued">{queuedText(studio.leaseInfo)}</span>
  {:else}<span aria-hidden="true">&#8635;</span> {ctaLabel(studio.everHeld)}{/if}
</button>

<style>
  .take { white-space: nowrap; display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; padding: 7px 14px; border-radius: 6px; cursor: pointer;
    background: var(--color-amber); color: #1a1300; border: 1px solid var(--color-amber); }
  .take:hover:not(:disabled) { filter: brightness(1.1); }
  .take:focus-visible { outline: 3px solid var(--color-text); outline-offset: 2px; }
  .take.compact { font-size: 12px; padding: 4px 10px; }
  .take:disabled { cursor: progress; background: transparent; color: var(--color-amber); }
  .spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: leasespin .8s linear infinite; }
  @keyframes leasespin { to { transform: rotate(360deg); } }
</style>
