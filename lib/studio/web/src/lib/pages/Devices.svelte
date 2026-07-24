<script>
  import { studio } from '../store.svelte.js';
  import { api } from '../api.js';
  const d = $derived(studio.device);
</script>

<div class="page">
  <div class="phead"><h1>Devices</h1></div>
  <p class="sub">The Roku this session is driving. Managing multiple devices and sideloading from the studio is planned.</p>

  <div class="device">
    <span class="dot" class:on={d}></span>
    <div>
      <div class="model">{d ? d.model : 'connecting…'}</div>
      <div class="meta">{d ? `firmware ${d.firmware}${d.developerEnabled ? ' · developer mode' : ''}` : ''}</div>
    </div>
    <span class="sp"></span>
    <button class="ghost" onclick={() => api.launch('dev')}>Relaunch dev channel</button>
  </div>

  <ul class="planned">
    <li>Add / switch devices by IP and dev password</li>
    <li>Run flows in parallel across several Rokus (sharded)</li>
    <li>Sideload / rebuild the app from the studio</li>
  </ul>
</div>

<style>
  .page { padding: 28px 32px; max-width: 720px; }
  h1 { font-family: var(--font-display); font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -.01em; }
  .sub { color: var(--color-haze); margin: 12px 0 20px; line-height: 1.6; }
  .device { display: flex; align-items: center; gap: 14px; padding: 16px; border: 1px solid var(--color-line); border-radius: 12px; background: var(--color-panel); }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--color-line2); }
  .dot.on { background: var(--color-pass); box-shadow: 0 0 10px var(--color-pass); }
  .model { font-weight: 600; }
  .meta { font-family: var(--font-mono); font-size: 12px; color: var(--color-haze); margin-top: 2px; }
  .sp { flex: 1; }
  .ghost { background: var(--color-panel2); color: var(--color-text); border: 1px solid var(--color-line2); border-radius: 8px; padding: 7px 14px; cursor: pointer; font-size: 12px; }
  .ghost:hover { border-color: var(--color-violet); }
  .planned { margin: 22px 0 0; padding: 0; list-style: none; display: grid; gap: 8px; }
  .planned li { padding: 11px 14px; border: 1px solid var(--color-line); border-radius: 10px; color: var(--color-haze); font-size: 13px; }
  .planned li::before { content: '→'; color: var(--color-violet); margin-right: 10px; }
</style>
