<script>
  import { studio } from './store.svelte.js';
  import { ctaLabel } from './leasecta.js';
  import LeaseTake from './LeaseTake.svelte';

  // The "device is held" message of a tile: names the exact control and carries the same button inline.
  let { text, testid = null, kind = null } = $props();
</script>

<div class="held">
  <p class="empty err" data-testid={testid} data-kind={kind}>{text} Use <b>{ctaLabel(studio.everHeld)}</b> above, or here:</p>
  <LeaseTake compact testid="lease-take-inline" />
</div>

<style>
  .held { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding-bottom: 8px; }
  .held p { margin: 0; }
  .held :global(button) { margin-left: 12px; }
</style>
